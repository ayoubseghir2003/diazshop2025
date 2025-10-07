require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Configuration
const SECRET_KEY = process.env.JWT_SECRET || 'supersecretkey';
const DATA_DIR = path.join(__dirname, 'data');
const AGENTS_FILE = path.join(DATA_DIR, 'delivery_agents.txt');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Initialize data files if they don't exist
if (!fs.existsSync(AGENTS_FILE)) fs.writeFileSync(AGENTS_FILE, '');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Data persistence functions
function loadOrders() {
  try {
    const data = fs.readFileSync(ORDERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error loading orders:', err);
    return [];
  }
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function loadAgents() {
  try {
    const data = fs.readFileSync(AGENTS_FILE, 'utf8');
    return data.split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [username, phone] = line.split(',');
        return { username, phone, role: 'agent' };
      });
  } catch (err) {
    console.error('Error loading agents:', err);
    return [];
  }
}

function saveAgents(agents) {
  const agentsData = agents
    .filter(u => u.role === 'agent')
    .map(u => `${u.username},${u.phone}\n`)
    .join('');
  fs.writeFileSync(AGENTS_FILE, agentsData);
}

// Authentication Middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No authorization header' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    req.user = jwt.verify(token, SECRET_KEY);
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// Routes

// Customer and Agent Login
app.post('/login', (req, res) => {
  const { phone, username, role = 'client' } = req.body;
  
  if (!phone || !username) {
    return res.status(400).json({ error: 'Phone and username required' });
  }

  let users = [...loadAgents(), ...loadOrders().map(o => ({
    phone: o.clientPhone,
    username: o.client,
    role: 'client'
  }))];

  let user = users.find(u => u.phone === phone);
  
  if (!user) {
    user = { phone, username, role };
    if (role === 'agent') {
      const agents = loadAgents();
      agents.push(user);
      saveAgents(agents);
    }
  }

  const token = jwt.sign({ phone, username, role }, SECRET_KEY, { expiresIn: '2h' });
  res.json({ token, user });
});

// Delivery Agent Endpoints
app.get('/delivery/orders', authenticate, (req, res) => {
  if (req.user.role !== 'agent') {
    return res.status(403).json({ error: 'Only delivery agents can access this' });
  }
  
  const orders = loadOrders();
  const agentOrders = orders.filter(o => 
    o.status === 'pending' || o.deliveryAgent === req.user.phone
  );
  res.json(agentOrders);
});

app.post('/delivery/orders/:id/assign', authenticate, (req, res) => {
  if (req.user.role !== 'agent') {
    return res.status(403).json({ error: 'Only delivery agents can access this' });
  }

  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') {
    return res.status(400).json({ error: 'Order already assigned' });
  }

  order.deliveryAgent = req.user.phone;
  order.status = 'assigned';
  order.agentName = req.user.username;
  saveOrders(orders);
  
  // In a real app, send notification to customer here
  res.json({ message: `Order ${order.id} assigned to you`, order });
});

app.post('/delivery/orders/:id/status', authenticate, (req, res) => {
  if (req.user.role !== 'agent') {
    return res.status(403).json({ error: 'Only delivery agents can access this' });
  }

  const { status } = req.body;
  const validStatuses = ['ready', 'in_transit', 'arrived', 'delivered'];
  
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.deliveryAgent !== req.user.phone) {
    return res.status(403).json({ error: 'This order is not assigned to you' });
  }

  order.status = status;
  saveOrders(orders);
  
  // In a real app, send notification to customer when status is 'arrived'
  res.json({ message: `Order ${order.id} status updated to "${status}"`, order });
});

// Customer Order Submission (from website)
app.post('/api/submit-order', (req, res) => {
  const { name, phone, address, cart, totalPrice, deliveryPrice } = req.body;

  if (!name || !phone || !address || !cart || totalPrice == null || deliveryPrice == null) {
    return res.status(400).json({ error: 'Missing order details' });
  }

  // Email setup (keep your existing email code)
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.ADMIN_EMAIL,
    subject: 'New Order Received',
    text: `New Order:
      Name: ${name}
      Phone: ${phone}
      Address: ${address}
      Items: ${cart.map(i => `${i.name} - DZA${i.price}`).join(', ')}
      Total: DZA${totalPrice}
      Delivery: DZA${deliveryPrice}`
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('Email error:', error);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    const orders = loadOrders();
    const newOrder = {
      id: String(Date.now()),
      client: name,
      clientPhone: phone,
      address,
      items: cart,
      total: totalPrice,
      deliveryPrice,
      status: 'pending',
      deliveryAgent: null,
      agentName: null,
      createdAt: new Date().toISOString()
    };
    
    orders.push(newOrder);
    saveOrders(orders);

    res.status(200).json({ 
      message: 'Order received!', 
      order: newOrder 
    });
  });
});

// Get order status (for customer tracking)
app.get('/api/orders/:phone', (req, res) => {
  const orders = loadOrders();
  const customerOrders = orders.filter(o => o.clientPhone === req.params.phone);
  res.json(customerOrders);
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});