import mongoose from 'mongoose';

const appointmentSchema = new mongoose.Schema(
  {
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    customerEmail: { type: String, required: true, lowercase: true, trim: true },
    appointmentDate: { type: String, required: true }, // YYYY-MM-DD
    timeSlot: { type: String, required: true, trim: true },
    message: { type: String, default: '', trim: true },
    servicePrice: { type: Number, required: true, min: 0 },
    paymentStatus: { type: String, enum: ['Unpaid', 'Paid'], default: 'Unpaid' },
    status: { type: String, enum: ['Pending', 'Confirmed', 'Cancelled'], default: 'Pending' },
  },
  { timestamps: true }
);

export default mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema);