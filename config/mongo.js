import mongoose from "mongoose";

let isConnected = false;

// Handle MongoDB connection events
mongoose.connection.on("connected", () => {
  console.log("MongoDB connected");
  isConnected = true;
});

mongoose.connection.on("error", (err) => {
  console.error("MongoDB connection error:", err);
  isConnected = false;
});

mongoose.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected");
  isConnected = false;
});

// Handle process termination
process.on("SIGINT", async () => {
  await mongoose.connection.close();
  console.log("MongoDB connection closed due to app termination");
  process.exit(0);
});

export async function connectMongo() {
  if (isConnected && mongoose.connection.readyState === 1) {
    return;
  }
  
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI is not set");
  }
  
  mongoose.set("strictQuery", true);
  
  try {
    await mongoose.connect(uri, {
      dbName: process.env.MONGO_DB || "curalink",
      serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
      socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
    });
    isConnected = true;
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    isConnected = false;
    throw error;
  }
}


