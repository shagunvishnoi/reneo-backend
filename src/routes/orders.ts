import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

interface OrderItemInput {
  product_id: string;
  quantity: number;
}

router.post('/', requireAuth, requireRole('CUSTOMER'), async (req: AuthenticatedRequest, res: Response) => {
  const { items, idempotency_key } = req.body as { items?: OrderItemInput[]; idempotency_key?: string };

  const rawBody = JSON.stringify(req.body);
  if (rawBody.includes('"price"') || rawBody.includes('"unit_price"') || rawBody.includes('"price_minor_units"')) {
    return res.status(400).json({ error: { code: 400, message: 'Price fields are not accepted from the client' } });
  }

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

  if (idempotency_key) {
    const { data: existingOrder } = await supabaseAdmin
      .from('orders')
      .select('id, total_minor_units, status')
      .eq('idempotency_key', idempotency_key)
      .eq('customer_id', customerId)
      .maybeSingle();

    if (existingOrder) {
      return res.status(200).json({
        data: { order_id: existingOrder.id, total_minor_units: existingOrder.total_minor_units },
        note: 'Duplicate request detected — returning original order.',
      });
    }
  }

  const { data, error } = await supabaseAdmin.rpc('place_order', {
    p_customer_id: customerId,
    p_items: items,
    p_idempotency_key: idempotency_key || null,
  });

  if (error) {
    const message = error.message || '';

    if (message.includes('duplicate key value violates unique constraint') && message.includes('idempotency_key')) {
      const { data: existingOrder } = await supabaseAdmin
        .from('orders')
        .select('id, total_minor_units')
        .eq('idempotency_key', idempotency_key)
        .single();
      return res.status(200).json({
        data: { order_id: existingOrder?.id, total_minor_units: existingOrder?.total_minor_units },
        note: 'Duplicate request detected — returning original order.',
      });
    }

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