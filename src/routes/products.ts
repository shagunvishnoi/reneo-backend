import { Router, Response } from 'express';
import { createUserClient } from '../config/supabase';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

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
// ==========================================
router.patch('/:id', requireAuth, requireRole('SELLER'), async (req: AuthenticatedRequest, res: Response) => {
  const { name, description, category, price_minor_units, is_archived } = req.body;

  if (price_minor_units !== undefined && (typeof price_minor_units !== 'number' || price_minor_units < 0)) {
    return res.status(400).json({ error: { code: 400, message: 'price_minor_units must be a non-negative number' } });
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
    return res.status(403).json({ error: { code: 403, message: 'Could not update product — not found or not yours' } });
  }

  return res.json({ data });
});

// ==========================================
// DELETE /products/:id — archive (SELLER, own only)
// ==========================================
router.delete('/:id', requireAuth, requireRole('SELLER'), async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getUserClient(req);

  const { data, error } = await supabase
    .from('products')
    .update({ is_archived: true, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) {
    return res.status(403).json({ error: { code: 403, message: 'Could not delete product — not found or not yours' } });
  }

  return res.json({ data: { message: 'Product archived', product: data } });
});

export default router;