import { Router, Response } from 'express';
import { createUserClient, supabasePublic, supabaseAdmin } from '../config/supabase';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// ==========================================
// GET /products/search — public search & pagination (A4)
// No auth required — anyone can browse products
// ==========================================
router.get('/search', async (req, res: Response) => {
  const {
    q,              // text search query
    category,       // exact category match
    min_price,      // minimum price in minor units
    max_price,      // maximum price in minor units
    in_stock,       // 'true' to only show items with stock > 0
    sort,           // 'price_asc' | 'price_desc' | 'newest'
    page = '1',
    limit = '20',
  } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20)); // cap at 100 to protect the server
  const offset = (pageNum - 1) * limitNum;

  const supabase = supabasePublic;
  let query = supabase
    .from('products')
    .select('*, inventory(stock)', { count: 'exact' })
    .eq('is_archived', false);

  if (q) {
    // Uses the GIN full-text index we created in the schema
    query = query.textSearch('name', q, { type: 'websearch' });
  }
  if (category) {
    query = query.eq('category', category);
  }
  if (min_price) {
    query = query.gte('price_minor_units', parseInt(min_price, 10));
  }
  if (max_price) {
    query = query.lte('price_minor_units', parseInt(max_price, 10));
  }

  if (sort === 'price_asc') query = query.order('price_minor_units', { ascending: true });
  else if (sort === 'price_desc') query = query.order('price_minor_units', { ascending: false });
  else query = query.order('created_at', { ascending: false }); // 'newest' default

  query = query.range(offset, offset + limitNum - 1);

  const { data, error, count } = await query;

  if (error) {
    return res.status(500).json({ error: { code: 500, message: 'Search failed', detail: error.message } });
  }

  // in_stock filter applied after fetch since it depends on the joined inventory table
  const filtered = in_stock === 'true' ? (data || []).filter((p: any) => p.inventory?.stock > 0) : data;

  return res.json({
    data: filtered,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total: count || 0,
      total_pages: Math.ceil((count || 0) / limitNum),
    },
  });
});

function getUserClient(req: AuthenticatedRequest) {
  const token = req.headers.authorization?.split(' ')[1] || '';
  return createUserClient(token);
}

// ==========================================
// POST /products — create (SELLER only)
// ==========================================
router.post('/', requireAuth, requireRole('SELLER'), async (req: AuthenticatedRequest, res: Response) => {
  const { store_id, name, description, category, price_minor_units, currency, stock } = req.body;

  if (!store_id || typeof store_id !== 'string') {
    return res.status(400).json({ error: { code: 400, message: 'store_id is required' } });
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: { code: 400, message: 'name is required' } });
  }
  if (!category || typeof category !== 'string') {
    return res.status(400).json({ error: { code: 400, message: 'category is required' } });
  }
  if (typeof price_minor_units !== 'number' || price_minor_units < 0) {
    return res.status(400).json({ error: { code: 400, message: 'price_minor_units must be a non-negative number' } });
  }
  if (stock !== undefined && (typeof stock !== 'number' || stock < 0)) {
    return res.status(400).json({ error: { code: 400, message: 'stock must be a non-negative number' } });
  }

  const supabase = getUserClient(req);

  const { data: product, error: productError } = await supabase
    .from('products')
    .insert({
      store_id,
      name: name.trim(),
      description: description || null,
      category,
      price_minor_units,
      currency: currency || 'XOF',
    })
    .select()
    .single();

  if (productError) {
    return res.status(403).json({ error: { code: 403, message: 'Could not create product — check store ownership', detail: productError.message } });
  }

  const { error: inventoryError } = await supabase
    .from('inventory')
    .insert({ product_id: product.id, stock: stock || 0 });

  if (inventoryError) {
    return res.status(500).json({ error: { code: 500, message: 'Product created but inventory setup failed', detail: inventoryError.message } });
  }

  return res.status(201).json({ data: product });
});

// ==========================================
// GET /products — list own products (SELLER)
// ==========================================
router.get('/', requireAuth, requireRole('SELLER'), async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getUserClient(req);

  const { data, error } = await supabase
    .from('products')
    .select('*, inventory(stock)')
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: { code: 500, message: 'Failed to fetch products', detail: error.message } });
  }

  return res.json({ data });
});

// ==========================================
// GET /products/:id — read one
// ==========================================
router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getUserClient(req);

  const { data, error } = await supabase
    .from('products')
    .select('*, inventory(stock)')
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: { code: 404, message: 'Product not found' } });
  }

  return res.json({ data });
});

// ==========================================
// PATCH /products/:id — update (SELLER, own only)
// A7 fix: distinguishes 404 (product genuinely doesn't exist)
// from 403 (product exists but isn't owned by this seller).
// Uses supabaseAdmin ONLY for the existence check, which bypasses
// RLS — this does not weaken security, since the actual write
// below still goes through the user's own RLS-scoped client.
// ==========================================
router.patch('/:id', requireAuth, requireRole('SELLER'), async (req: AuthenticatedRequest, res: Response) => {
  const { name, description, category, price_minor_units, is_archived } = req.body;

  if (price_minor_units !== undefined && (typeof price_minor_units !== 'number' || price_minor_units < 0)) {
    return res.status(400).json({ error: { code: 400, message: 'price_minor_units must be a non-negative number' } });
  }

  const { data: existing } = await supabaseAdmin
    .from('products')
    .select('id')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!existing) {
    return res.status(404).json({ error: { code: 404, message: 'Product not found' } });
  }

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (category !== undefined) updates.category = category;
  if (price_minor_units !== undefined) updates.price_minor_units = price_minor_units;
  if (is_archived !== undefined) updates.is_archived = is_archived;
  updates.updated_at = new Date().toISOString();

  const supabase = getUserClient(req);

  const { data, error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) {
    return res.status(403).json({ error: { code: 403, message: 'Product exists but you do not have permission to modify it' } });
  }

  return res.json({ data });
});

// ==========================================
// DELETE /products/:id — archive (SELLER, own only)
// Same 404 vs 403 distinction as PATCH above.
// ==========================================
router.delete('/:id', requireAuth, requireRole('SELLER'), async (req: AuthenticatedRequest, res: Response) => {
  const { data: existing } = await supabaseAdmin
    .from('products')
    .select('id')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!existing) {
    return res.status(404).json({ error: { code: 404, message: 'Product not found' } });
  }

  const supabase = getUserClient(req);

  const { data, error } = await supabase
    .from('products')
    .update({ is_archived: true, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) {
    return res.status(403).json({ error: { code: 403, message: 'Product exists but you do not have permission to delete it' } });
  }

  return res.json({ data: { message: 'Product archived', product: data } });
});

export default router;