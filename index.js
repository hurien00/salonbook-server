import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import multer from 'multer';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 5000;

const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:3000',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
        callback(null, true);
      } else {
        callback(new Error('Blocked by CORS policy'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-user-role',
      'x-user-id',
      'x-user-email',
    ],
  }),
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Ensure uploads directory exists and serve statically
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// Multer setup for Service Image uploads
const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, uploadDir);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);
    cb(null, `${Date.now()}-${base || 'service'}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, WEBP, or GIF image files are allowed'));
    }
  },
});

// Helper to safely delete local uploaded file when replacing or deleting a service
function removeLocalUploadIfExists(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return;
  const marker = '/uploads/';
  const idx = imageUrl.indexOf(marker);
  if (idx === -1) return;

  const fileName = path.basename(imageUrl.slice(idx + marker.length));
  if (!fileName) return;

  const fullPath = path.join(uploadDir, fileName);
  if (fullPath.startsWith(uploadDir) && fs.existsSync(fullPath)) {
    fs.unlink(fullPath, (err) => {
      if (err) console.warn('Could not remove old upload:', err.message);
    });
  }
}

const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD;

if (!dbUser || !dbPassword) {
  console.error('Missing DB_USER or DB_PASSWORD in environment variables');
  process.exit(1);
}

const uri = `mongodb+srv://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@cluster0.93riodr.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri);

export async function connectToMongoDB() {
  await client.connect();
  console.log('You successfully connected to MongoDB!');
  return client;
}

let usersCollection;
let servicesCollection;
let appointmentsCollection;
let transactionsCollection;

// Verify admin role from DB user record, session/user object, or header
async function requireAdmin(req, res, next) {
  try {
    const headerRole = req.headers['x-user-role']
      ? String(req.headers['x-user-role']).toLowerCase()
      : null;
    const userId = req.headers['x-user-id'] ? String(req.headers['x-user-id']).trim() : null;
    const userEmail = req.headers['x-user-email']
      ? String(req.headers['x-user-email']).trim().toLowerCase()
      : null;

    if (usersCollection && (userId || userEmail)) {
      const orConditions = [];
      if (userId) {
        if (ObjectId.isValid(userId)) {
          orConditions.push({ _id: new ObjectId(userId) });
        }
        orConditions.push({ id: userId });
      }
      if (userEmail) {
        orConditions.push({ email: userEmail });
      }

      if (orConditions.length > 0) {
        const dbUserDoc = await usersCollection.findOne({ $or: orConditions });
        if (dbUserDoc && String(dbUserDoc.role).toLowerCase() === 'admin') {
          req.user = dbUserDoc;
          return next();
        }
      }
    }

    const sessionRole = req.user?.role || req.session?.user?.role;
    if (sessionRole && String(sessionRole).toLowerCase() === 'admin') {
      return next();
    }

    if (headerRole === 'admin' && process.env.NODE_ENV !== 'production') {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: 'Forbidden: Only Admin can create, update, or delete services',
    });
  } catch (error) {
    console.error('Admin verification error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify admin role',
    });
  }
}

async function startServer() {
  try {
    const connectedClient = await connectToMongoDB();
    const database = connectedClient.db('salonbookdb');
    usersCollection = database.collection('user');
    servicesCollection = database.collection('services');
    appointmentsCollection = database.collection('appointments');
    transactionsCollection = database.collection('transactions');

    app.get('/', (_req, res) => {
      res.send('connected');
    });

    app.get('/api/health', (_req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'SalonBook Backend REST API',
      });
    });

    app.get('/user', async (_req, res) => {
      try {
        const result = await usersCollection.find({}).toArray();
        res.json(result);
      } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch users' });
      }
    });

    // Admin overview KPI stats
    app.get('/appointments/stats/admin', async (_req, res) => {
      try {
        const [
          totalCustomers,
          totalActiveServices,
          totalAppointments,
          pendingAppointments,
          confirmedAppointments,
          successfulTransactions,
        ] = await Promise.all([
          usersCollection.countDocuments({ role: { $ne: 'admin' } }),
          servicesCollection.countDocuments({ status: 'active' }),
          appointmentsCollection.countDocuments({}),
          appointmentsCollection.countDocuments({ status: 'pending' }),
          appointmentsCollection.countDocuments({ status: 'confirmed' }),
          transactionsCollection.find({ status: 'succeeded' }).toArray(),
        ]);

        const totalSuccessfulPayments = successfulTransactions.length;
        const totalRevenue = successfulTransactions.reduce(
          (sum, tx) => sum + Number(tx.amount || 0),
          0,
        );

        res.json({
          success: true,
          data: {
            totalCustomers,
            totalActiveServices,
            totalAppointments,
            pendingAppointments,
            confirmedAppointments,
            totalSuccessfulPayments,
            totalRevenue,
          },
        });
      } catch (error) {
        console.error('Error fetching admin stats:', error);
        res.status(500).json({ success: false, message: 'Failed to load admin stats' });
      }
    });

    // Get all services (supports search, category, sort, includeInactive)
    app.get('/services', async (req, res) => {
      try {
        const { search, category, sort, includeInactive } = req.query;
        const query = {};

        if (includeInactive !== 'true') {
          query.status = 'active';
        }

        if (category && category !== 'All') {
          query.category = String(category);
        }

        if (search && String(search).trim()) {
          query.serviceName = { $regex: String(search).trim(), $options: 'i' };
        }

        let sortOption = { createdAt: -1 };
        if (sort === 'price_asc') sortOption = { price: 1 };
        if (sort === 'price_desc') sortOption = { price: -1 };

        const data = await servicesCollection.find(query).sort(sortOption).toArray();
        res.json({ success: true, data });
      } catch (error) {
        console.error('Error fetching services:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch services' });
      }
    });

    // Get single service by ID
    app.get('/services/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: 'Invalid service ID' });
        }

        const service = await servicesCollection.findOne({ _id: new ObjectId(id) });
        if (!service) {
          return res.status(404).json({ success: false, message: 'Service not found' });
        }

        res.json({ success: true, data: service });
      } catch (error) {
        console.error('Error fetching service details:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch service' });
      }
    });

    // Create service (Admin only + FormData image upload + positive number validation)
    app.post('/services', requireAdmin, upload.single('image'), async (req, res) => {
      try {
        const { serviceName, category, description, price, duration, status } = req.body;
        const numericPrice = Number(price);
        const numericDuration = Number(duration);

        if (!serviceName || !String(serviceName).trim()) {
          return res.status(400).json({ success: false, message: 'Service Name is required' });
        }
        if (!category || !String(category).trim()) {
          return res
            .status(400)
            .json({ success: false, message: 'Service Category is required' });
        }
        if (!description || !String(description).trim()) {
          return res.status(400).json({ success: false, message: 'Description is required' });
        }
        if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
          return res
            .status(400)
            .json({ success: false, message: 'Price must be a positive number' });
        }
        if (!Number.isFinite(numericDuration) || numericDuration <= 0) {
          return res
            .status(400)
            .json({ success: false, message: 'Duration must be a positive number' });
        }
        if (!req.file) {
          return res.status(400).json({ success: false, message: 'Service image is required' });
        }

        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const imageUrl = `${baseUrl}/uploads/${req.file.filename}`;
        const normalizedStatus = status === 'inactive' ? 'inactive' : 'active';

        const newService = {
          serviceName: String(serviceName).trim(),
          category: String(category).trim(),
          description: String(description).trim(),
          price: numericPrice,
          duration: numericDuration,
          image: imageUrl,
          status: normalizedStatus,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const insertResult = await servicesCollection.insertOne(newService);
        const createdService = { _id: insertResult.insertedId, ...newService };

        res.status(201).json({ success: true, data: createdService });
      } catch (error) {
        console.error('Error creating service:', error);
        res.status(500).json({ success: false, message: 'Failed to create service' });
      }
    });

   
    // Global & Multer error handler
    app.use((err, _req, res, _next) => {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, message: err.message });
      }
      if (err) {
        return res
          .status(400)
          .json({ success: false, message: err.message || 'Bad request error' });
      }
      return res.status(500).json({ success: false, message: 'Internal server error' });
    });

    app.listen(port, () => {
      console.log(`salon running on port ${port}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

void startServer();