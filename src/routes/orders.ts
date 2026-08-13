import { Router, Response } from 'express';
import { supabaseAdmin, createUserClient } from '../config/supabase';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

interface OrderItemInput {
  product_id: string;
  quantity: number;
}

// ==========================================
// POST /orders — create (CUSTOMER only)
// ==========================================
router.post('/', requireAuth, requireRole('CUSTOMER'), async (req: AuthenticatedRequest, res: Response) => {
  const { items } = req.body as { items?: OrderItemInput[] };

  // --- Reject if client tries to send a price anywhere ---
  const rawBody = JSON.stringify(req.body);
  if (rawBody.includes('"price"') || rawBody.includes('"unit_price"') || rawBody.includes('"price_minor_units"')) {
    return res.status(400).json({ error: { code: 400, message: 'Price fields are not accepted from the client' } });
  }

  // --- Basic validation ---
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: { code: 400, message: 'items array is required and cannot be empty' } });
  }

  for (const item of items) {
    if (!item.product_id || typeof item.product_id !== 'string') {
      return res.status(400).json({ error: { code: 400, message: 'Each item requires a valid product_id' } });
    }
    if (typeof item.quantity !== 'number' || item.quantity <= 0 || !Number.isInteger(item.quantity)) {
      return res.status(400).json({ error: { code: 400, message: 'Each item requires a positive integer quantity' } });
    }
  }

  const customerId = req.user!.id;

  // --- Call the atomic, concurrency-safe database function ---
  // We use supabaseAdmin here deliberately: the function needs to update
  // inventory rows the customer doesn't own permission over directly,
  // and the function itself is what enforces correctness (not the client's role).
  const { data, error } = await supabaseAdmin.rpc('place_order', {
    p_customer_id: customerId,
    p_items: items,
  });

  if (error) {
    const message = error.message || '';

    if (message.includes('OUT_OF_STOCK')) {
      return res.status(409).json({ error: { code: 409, message: 'Insufficient stock for one or more items', detail: message } });
    }
    if (message.includes('PRODUCT_NOT_FOUND')) {
      return res.status(404).json({ error: { code: 404, message: 'One or more products not found', detail: message } });
    }
    if (message.includes('PRODUCT_UNAVAILABLE')) {
      return res.status(409).json({ error: { code: 409, message: 'One or more products are unavailable', detail: message } });
    }

    return res.status(500).json({ error: { code: 500, message: 'Failed to create order', detail: message } });
  }

  return res.status(201).json({ data });
});

export default router;