const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema(
  {
    serviceName: {
      type: String,
      required: [true, 'Service name is required'],
      trim: true,
      maxlength: [120, 'Service name cannot exceed 120 characters'],
    },
    category: {
      type: String,
      required: [true, 'Service category is required'],
      trim: true,
    },
    description: {
      type: String,
      required: [true, 'Service description is required'],
      trim: true,
    },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0.01, 'Price must be a positive number'],
      validate: {
        validator: (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
        message: 'Price must be a positive number',
      },
    },
    duration: {
      type: Number,
      required: [true, 'Estimated duration in minutes is required'],
      min: [1, 'Estimated duration must be at least 1 minute'],
      validate: {
        validator: (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
        message: 'Estimated duration must be a positive number',
      },
    },
    image: {
      type: String,
      required: [true, 'Service image is required'],
      trim: true,
    },
    status: {
      type: String,
      enum: {
        values: ['active', 'inactive'],
        message: 'Status must be either active or inactive',
      },
      default: 'active',
    },
    createdBy: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'services',
  }
);

// Search and filter indexing for faster queries
serviceSchema.index({ serviceName: 'text', description: 'text', category: 'text' });

module.exports = mongoose.model('Service', serviceSchema);