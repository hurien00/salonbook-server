import Appointment from '../models/Appointment.js';
import Service from '../models/Service.js';

// Customer creates appointment
export const createAppointment = async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (user.role === 'admin') {
      return res.status(403).json({ success: false, message: 'Only customers can book' });
    }

    const { serviceId, appointmentDate, timeSlot, message } = req.body;
    if (!serviceId || !appointmentDate || !timeSlot) {
      return res.status(400).json({ success: false, message: 'Date and time slot are required' });
    }

    const service = await Service.findById(serviceId);
    if (!service) return res.status(404).json({ success: false, message: 'Service not found' });
    if (service.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Service is inactive' });
    }

    const duplicate = await Appointment.findOne({
      serviceId,
      appointmentDate,
      timeSlot,
      status: { $in: ['Pending', 'Confirmed'] },
    });
    if (duplicate) {
      return res.status(409).json({ success: false, message: 'Slot already booked' });
    }

    const appointment = await Appointment.create({
      serviceId: service._id,
      customerId: user._id,
      customerEmail: user.email,
      appointmentDate,
      timeSlot,
      message: message || '',
      servicePrice: service.price,
      paymentStatus: 'Unpaid',
      status: 'Pending',
    });

    res.status(201).json({ success: true, data: appointment });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Get appointments (Admin: all, Customer: own)
export const getAppointments = async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const filter = user.role === 'admin' ? {} : { customerEmail: user.email };
    const data = await Appointment.find(filter).populate('serviceId', 'serviceName price duration').sort({ createdAt: -1 });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Update status (Customer: cancel own Pending | Admin: Confirm or Cancel)
export const updateAppointmentStatus = async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { status } = req.body;
    const appointment = await Appointment.findById(req.params.id);
    if (!appointment) return res.status(404).json({ success: false, message: 'Not found' });

    if (user.role === 'admin') {
      if (!['Confirmed', 'Cancelled'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
      }
      appointment.status = status;
      await appointment.save();
      return res.json({ success: true, data: appointment });
    }

    const isOwner =
      String(appointment.customerId) === String(user._id) ||
      appointment.customerEmail === user.email;

    if (!isOwner) return res.status(403).json({ success: false, message: 'Forbidden' });
    if (status !== 'Cancelled') {
      return res.status(403).json({ success: false, message: 'Customers can only cancel' });
    }
    if (appointment.status !== 'Pending') {
      return res.status(400).json({ success: false, message: 'Only pending requests can be cancelled' });
    }

    appointment.status = 'Cancelled';
    await appointment.save();
    res.json({ success: true, data: appointment });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};