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
  'http://localhost:3004',
  'http://127.0.0.1:3004',
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

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

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

function isValidHttpUrl(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

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

async function resolveRequestUser(req) {
  const userId = req.headers['x-user-id'] ? String(req.headers['x-user-id']).trim() : null;
  const userEmail = req.headers['x-user-email']
    ? String(req.headers['x-user-email']).trim().toLowerCase()
    : null;
  const headerRole = req.headers['x-user-role']
    ? String(req.headers['x-user-role']).trim().toLowerCase()
    : null;

  if (usersCollection && (userId || userEmail)) {
    const orConditions = [];
    if (userId) {
      if (ObjectId.isValid(userId)) orConditions.push({ _id: new ObjectId(userId) });
      orConditions.push({ id: userId });
    }
    if (userEmail) orConditions.push({ email: userEmail });

    if (orConditions.length > 0) {
      const dbUserDoc = await usersCollection.findOne({ $or: orConditions });
      if (dbUserDoc) {
        return { ...dbUserDoc, role: dbUserDoc.role || headerRole || 'customer' };
      }
    }
  }

  if (req.user) return req.user;
  if ((userId || userEmail) && headerRole) {
    return { _id: userId || userEmail, email: userEmail || '', role: headerRole };
  }

  return null;
}

async function requireAdmin(req, res, next) {
  try {
    const currentUser = await resolveRequestUser(req);
    if (currentUser && String(currentUser.role || '').toLowerCase() === 'admin') {
      req.user = currentUser;
      return next();
    }

    const headerRole = req.headers['x-user-role']
      ? String(req.headers['x-user-role']).toLowerCase()
      : null;
    if (headerRole === 'admin' && process.env.NODE_ENV !== 'production') {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: 'Forbidden: Only Admin can perform this action',
    });
  } catch (error) {
    console.error('Admin verification error:', error);
    return res.status(500).json({ success: false, message: 'Failed to verify admin role' });
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

    // Update logged-in user/admin profile
    app.put('/auth/profile', async (req, res) => {
      try {
        const currentUser = await resolveRequestUser(req);
        if (!currentUser) {
          return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { name, phone, image } = req.body;
        if (!name || !String(name).trim()) {
          return res.status(400).json({ success: false, message: 'Name cannot be empty' });
        }

        const updateFields = {
          name: String(name).trim(),
          phone: phone !== undefined ? String(phone).trim() : currentUser.phone || '',
          updatedAt: new Date(),
        };

        if (image !== undefined && String(image).trim()) {
          if (!isValidHttpUrl(image)) {
            return res.status(400).json({ success: false, message: 'Invalid image URL' });
          }
          updateFields.image = String(image).trim();
        }

        const filter =
          currentUser._id && ObjectId.isValid(String(currentUser._id))
            ? { _id: new ObjectId(String(currentUser._id)) }
            : { email: String(currentUser.email).toLowerCase() };

        const updatedDoc = await usersCollection.findOneAndUpdate(
          filter,
          { $set: updateFields },
          { returnDocument: 'after' },
        );

        const resultDoc = updatedDoc?.value || updatedDoc || { ...currentUser, ...updateFields };
        return res.json({
          success: true,
          message: 'Profile updated successfully',
          data: resultDoc,
        });
      } catch (error) {
        console.error('Error updating profile:', error);
        return res.status(500).json({ success: false, message: 'Failed to update profile' });
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
          appointmentsCollection.countDocuments({ status: { $in: ['Pending', 'pending'] } }),
          appointmentsCollection.countDocuments({ status: { $in: ['Confirmed', 'confirmed'] } }),
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

    // Get all services
    app.get('/services', async (req, res) => {
      try {
        const { search, category, sort, includeInactive } = req.query;
        const query = {};

        if (includeInactive !== 'true') query.status = 'active';
        if (category && category !== 'All') query.category = String(category);
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

    // Create service (Admin only)
    app.post('/services', requireAdmin, upload.single('image'), async (req, res) => {
      try {
        const { serviceName, category, description, price, duration, status, image } = req.body;
        const numericPrice = Number(price);
        const numericDuration = Number(duration);

        if (!serviceName || !String(serviceName).trim()) {
          return res.status(400).json({ success: false, message: 'Service Name is required' });
        }
        if (!category || !String(category).trim()) {
          return res.status(400).json({ success: false, message: 'Service Category is required' });
        }
        if (!description || !String(description).trim()) {
          return res.status(400).json({ success: false, message: 'Description is required' });
        }
        if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
          return res.status(400).json({ success: false, message: 'Price must be a positive number' });
        }
        if (!Number.isFinite(numericDuration) || numericDuration <= 0) {
          return res.status(400).json({ success: false, message: 'Duration must be a positive number' });
        }

        let finalImageUrl = '';
        if (req.file) {
          finalImageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        } else if (isValidHttpUrl(image)) {
          finalImageUrl = String(image).trim();
        } else {
          return res.status(400).json({ success: false, message: 'Valid service image URL or file is required' });
        }

        const newService = {
          serviceName: String(serviceName).trim(),
          category: String(category).trim(),
          description: String(description).trim(),
          price: numericPrice,
          duration: numericDuration,
          image: finalImageUrl,
          status: status === 'inactive' ? 'inactive' : 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const insertResult = await servicesCollection.insertOne(newService);
        res.status(201).json({ success: true, data: { _id: insertResult.insertedId, ...newService } });
      } catch (error) {
        console.error('Error creating service:', error);
        res.status(500).json({ success: false, message: 'Failed to create service' });
      }
    });

    // Update service (Admin only)
    app.patch('/services/:id', requireAdmin, upload.single('image'), async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: 'Invalid service ID' });
        }

        const existingService = await servicesCollection.findOne({ _id: new ObjectId(id) });
        if (!existingService) {
          return res.status(404).json({ success: false, message: 'Service not found' });
        }

        const { serviceName, category, description, price, duration, status, image } = req.body;
        const updateFields = { updatedAt: new Date() };

        if (serviceName !== undefined) {
          if (!String(serviceName).trim()) {
            return res.status(400).json({ success: false, message: 'Service Name cannot be empty' });
          }
          updateFields.serviceName = String(serviceName).trim();
        }
        if (category !== undefined) {
          if (!String(category).trim()) {
            return res.status(400).json({ success: false, message: 'Service Category cannot be empty' });
          }
          updateFields.category = String(category).trim();
        }
        if (description !== undefined) {
          if (!String(description).trim()) {
            return res.status(400).json({ success: false, message: 'Description cannot be empty' });
          }
          updateFields.description = String(description).trim();
        }
        if (price !== undefined) {
          const numericPrice = Number(price);
          if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
            return res.status(400).json({ success: false, message: 'Price must be a positive number' });
          }
          updateFields.price = numericPrice;
        }
        if (duration !== undefined) {
          const numericDuration = Number(duration);
          if (!Number.isFinite(numericDuration) || numericDuration <= 0) {
            return res.status(400).json({ success: false, message: 'Duration must be a positive number' });
          }
          updateFields.duration = numericDuration;
        }
        if (status !== undefined) {
          updateFields.status = status === 'inactive' ? 'inactive' : 'active';
        }
        if (req.file) {
          updateFields.image = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
          removeLocalUploadIfExists(existingService.image);
        } else if (image !== undefined) {
          if (!isValidHttpUrl(image)) {
            return res.status(400).json({ success: false, message: 'Invalid service image URL' });
          }
          updateFields.image = String(image).trim();
          removeLocalUploadIfExists(existingService.image);
        }

        const updatedDoc = await servicesCollection.findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateFields },
          { returnDocument: 'after' },
        );

        res.json({ success: true, data: updatedDoc?.value || updatedDoc });
      } catch (error) {
        console.error('Error updating service:', error);
        res.status(500).json({ success: false, message: 'Failed to update service' });
      }
    });

    // Delete service (Admin only)
    app.delete('/services/:id', requireAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: 'Invalid service ID' });
        }

        const existingService = await servicesCollection.findOne({ _id: new ObjectId(id) });
        if (!existingService) {
          return res.status(404).json({ success: false, message: 'Service not found' });
        }

        await servicesCollection.deleteOne({ _id: new ObjectId(id) });
        removeLocalUploadIfExists(existingService.image);
        res.json({ success: true, message: 'Service deleted successfully' });
      } catch (error) {
        console.error('Error deleting service:', error);
        res.status(500).json({ success: false, message: 'Failed to delete service' });
      }
    });

    // Create appointment request (Authenticated Customers only)
    app.post('/appointments', async (req, res) => {
      try {
        const currentUser = await resolveRequestUser(req);
        if (!currentUser) {
          return res.status(401).json({
            success: false,
            message: 'Unauthorized: Please sign in as a customer to book an appointment',
          });
        }

        if (String(currentUser.role || 'customer').toLowerCase() === 'admin') {
          return res.status(403).json({
            success: false,
            message: 'Forbidden: Only customers can submit appointment requests',
          });
        }

        const { serviceId, appointmentDate, timeSlot, message } = req.body;
        if (!serviceId || !ObjectId.isValid(String(serviceId))) {
          return res.status(400).json({ success: false, message: 'Valid service ID is required' });
        }
        if (!appointmentDate || !String(appointmentDate).trim()) {
          return res.status(400).json({ success: false, message: 'Appointment date is required' });
        }
        if (!timeSlot || !String(timeSlot).trim()) {
          return res.status(400).json({ success: false, message: 'Available time slot is required' });
        }

        const serviceObjId = new ObjectId(String(serviceId));
        const service = await servicesCollection.findOne({ _id: serviceObjId });
        if (!service) {
          return res.status(404).json({ success: false, message: 'Service not found' });
        }

        if (String(service.status).toLowerCase() !== 'active') {
          return res.status(400).json({
            success: false,
            message: 'This service is currently inactive and cannot be booked',
          });
        }

        const cleanDate = String(appointmentDate).trim();
        const cleanSlot = String(timeSlot).trim();

        const duplicateActive = await appointmentsCollection.findOne({
          serviceId: { $in: [serviceObjId, String(service._id)] },
          appointmentDate: cleanDate,
          timeSlot: cleanSlot,
          status: { $in: ['Pending', 'Confirmed', 'pending', 'confirmed'] },
        });

        if (duplicateActive) {
          return res.status(409).json({
            success: false,
            message: 'This date and time slot is already booked for this service',
          });
        }

        const customerIdValue =
          currentUser._id && ObjectId.isValid(String(currentUser._id))
            ? new ObjectId(String(currentUser._id))
            : String(currentUser._id || currentUser.id || '');

        const newAppointment = {
          serviceId: serviceObjId,
          serviceName: service.serviceName,
          customerId: customerIdValue,
          customerEmail: String(currentUser.email || '').toLowerCase(),
          appointmentDate: cleanDate,
          timeSlot: cleanSlot,
          message: message ? String(message).trim() : '',
          servicePrice: Number(service.price || 0),
          paymentStatus: 'Unpaid',
          status: 'Pending',
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const insertResult = await appointmentsCollection.insertOne(newAppointment);
        return res.status(201).json({
          success: true,
          message: 'Appointment request submitted successfully!',
          data: { _id: insertResult.insertedId, ...newAppointment },
        });
      } catch (error) {
        console.error('Error creating appointment:', error);
        return res.status(500).json({ success: false, message: 'Failed to submit appointment request' });
      }
    });

    // Get appointments (Admin: all; Customer: own)
    app.get('/appointments', async (req, res) => {
      try {
        const currentUser = await resolveRequestUser(req);
        if (!currentUser) {
          return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const role = String(currentUser.role || 'customer').toLowerCase();
        const query = {};

        if (role !== 'admin') {
          const orConditions = [];
          if (currentUser._id) {
            orConditions.push({ customerId: String(currentUser._id) });
            if (ObjectId.isValid(String(currentUser._id))) {
              orConditions.push({ customerId: new ObjectId(String(currentUser._id)) });
            }
          }
          if (currentUser.email) {
            orConditions.push({ customerEmail: String(currentUser.email).toLowerCase() });
          }
          query.$or = orConditions;
        }

        const data = await appointmentsCollection.find(query).sort({ createdAt: -1 }).toArray();
        return res.json({ success: true, data });
      } catch (error) {
        console.error('Error fetching appointments:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch appointments' });
      }
    });

    // Update appointment status (Customer: cancel own Pending; Admin: Confirm or Cancel)
    app.patch('/appointments/:id/status', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: 'Invalid appointment ID' });
        }

        const currentUser = await resolveRequestUser(req);
        if (!currentUser) {
          return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const appointment = await appointmentsCollection.findOne({ _id: new ObjectId(id) });
        if (!appointment) {
          return res.status(404).json({ success: false, message: 'Appointment not found' });
        }

        const rawStatus = String(req.body.status || '').trim().toLowerCase();
        const targetStatus =
          rawStatus === 'confirmed' ? 'Confirmed' : rawStatus === 'cancelled' ? 'Cancelled' : null;

        if (!targetStatus) {
          return res.status(400).json({ success: false, message: 'Status must be Confirmed or Cancelled' });
        }

        const role = String(currentUser.role || 'customer').toLowerCase();

        if (role === 'admin') {
          const updated = await appointmentsCollection.findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $set: { status: targetStatus, updatedAt: new Date() } },
            { returnDocument: 'after' },
          );
          return res.json({
            success: true,
            message: `Appointment ${targetStatus} successfully`,
            data: updated?.value || updated,
          });
        }

        const userIdStr = String(currentUser._id || currentUser.id || '');
        const userEmailStr = String(currentUser.email || '').toLowerCase();
        const isOwner =
          (userIdStr && String(appointment.customerId) === userIdStr) ||
          (userEmailStr && String(appointment.customerEmail || '').toLowerCase() === userEmailStr);

        if (!isOwner) {
          return res.status(403).json({
            success: false,
            message: 'Forbidden: You can only cancel your own appointments',
          });
        }
        if (targetStatus !== 'Cancelled') {
          return res.status(403).json({
            success: false,
            message: 'Customers can only cancel appointment requests',
          });
        }
        if (String(appointment.status).toLowerCase() !== 'pending') {
          return res.status(400).json({
            success: false,
            message: 'Only pending appointment requests can be cancelled',
          });
        }

        const updated = await appointmentsCollection.findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: { status: 'Cancelled', updatedAt: new Date() } },
          { returnDocument: 'after' },
        );

        return res.json({
          success: true,
          message: 'Appointment cancelled successfully',
          data: updated?.value || updated,
        });
      } catch (error) {
        console.error('Error updating appointment status:', error);
        return res.status(500).json({ success: false, message: 'Failed to update appointment status' });
      }
    });

    // Global & Multer error handler
    app.use((err, _req, res, _next) => {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, message: err.message });
      }
      if (err) {
        return res.status(400).json({ success: false, message: err.message || 'Bad request error' });
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