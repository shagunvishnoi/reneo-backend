import 'dotenv/config';

import express from 'express';
import productsRouter from './routes/products';
import ordersRouter from './routes/orders';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ message: 'Reneo backend is running' });
});

app.use('/products', productsRouter);
app.use('/orders', ordersRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});