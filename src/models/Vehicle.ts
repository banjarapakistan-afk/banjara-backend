import mongoose, { Schema, Types } from 'mongoose';

export type VehicleStatus = 'pending' | 'active' | 'rejected' | 'suspended';

export interface ISeatConfiguration {
  rows?: number;
  seatsPerRow?: number;
  layoutType?: string;
}

export interface IVehicle {
  verificationDetails?: Record<string, unknown>;
  registrationCompletedAt?: Date;
  _id: Types.ObjectId;
  providerId: Types.ObjectId;
  name: string;
  type: 'van' | 'bus' | 'car' | 'minibus' | 'tourVehicle' | 'coaster' | 'suv' | 'jeep' | 'other';
  brand: string;
  vehicleModel: string;
  year: number;
  registrationNumber: string;
  /** Permanent physical capacity — never changed by bookings */
  seatCount: number;
  seatConfiguration?: ISeatConfiguration;
  amenities: string[];
  images: string[];
  status: VehicleStatus;
  rejectionReason?: string;
  approvedBy?: Types.ObjectId;
  approvedAt?: Date;
  rejectedBy?: Types.ObjectId;
  rejectedAt?: Date;
  suspendedBy?: Types.ObjectId;
  suspendedAt?: Date;
  /** The driver's own running costs for City to City fares; empty fields use BANJARA's defaults. */
  costProfile?: IVehicleCostProfile;
  createdAt: Date;
  updatedAt: Date;
}

export interface IVehicleCostProfile {
  fuelType?: 'petrol' | 'diesel';
  kmPerLitre?: number;
  /** PKR per trip. */
  maintenance?: number;
  labour?: number;
  insurance?: number;
  vipCharge?: number;
  /** The driver's Saver / Premium prices, % below / above their standard price. */
  saverPercent?: number;
  premiumPercent?: number;
}

const seatConfigurationSchema = new Schema<ISeatConfiguration>(
  {
    rows: Number,
    seatsPerRow: Number,
    layoutType: String,
  },
  { _id: false }
);

const vehicleSchema = new Schema<IVehicle>(
  {
    // Driver/insurance information is only returned to the owner and administrators.
    verificationDetails: { type: Schema.Types.Mixed, select: false },
    registrationCompletedAt: Date,
    providerId: { type: Schema.Types.ObjectId, ref: 'ProviderProfile', required: true, index: true },
    name: { type: String, required: true },
    type: {
      type: String,
      enum: ['van', 'bus', 'car', 'minibus', 'tourVehicle', 'coaster', 'suv', 'jeep', 'other'],
      required: true,
    },
    brand: { type: String, required: true },
    vehicleModel: { type: String, required: true },
    year: { type: Number, required: true },
    registrationNumber: { type: String, required: true, index: true },
    seatCount: { type: Number, required: true, min: 1 },
    seatConfiguration: { type: seatConfigurationSchema },
    amenities: { type: [String], default: [] },
    images: { type: [String], default: [] },
    status: {
      type: String,
      enum: ['pending', 'active', 'rejected', 'suspended'],
      default: 'pending',
      index: true,
    },
    rejectionReason: { type: String, trim: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: Date,
    suspendedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    suspendedAt: Date,
    costProfile: {
      type: new Schema<IVehicleCostProfile>(
        {
          fuelType: { type: String, enum: ['petrol', 'diesel'] },
          kmPerLitre: { type: Number, min: 1, max: 60 },
          maintenance: { type: Number, min: 0 },
          labour: { type: Number, min: 0 },
          insurance: { type: Number, min: 0 },
          vipCharge: { type: Number, min: 0 },
          saverPercent: { type: Number, min: 0, max: 90 },
          premiumPercent: { type: Number, min: 0, max: 90 },
        },
        { _id: false }
      ),
      default: undefined,
    },
  },
  { timestamps: true }
);

export const Vehicle = mongoose.model<IVehicle>('Vehicle', vehicleSchema);
