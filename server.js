const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Tesseract = require('tesseract.js');
const Razorpay = require('razorpay');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:8080', 'https://parkmate-admin.vercel.app'] }));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.get('/', (req, res) => res.send('ParkMate Backend'));

// Registration
app.post('/register', async (req, res) => {
  const { email, password, name, phone, role = 'user' } = req.body;
  console.log('Register request:', { email, name, phone, role });

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name, phone, role } },
  });
  if (error) {
    console.log('Auth signup error:', error);
    return res.status(400).json({ error: error.message });
  }
  res.status(201).json({ message: 'User registered', user: data.user });
});

// Login (No JWT yet)
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  console.log('Login request:', { email });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.log('Login error:', error);
    return res.status(400).json({ error: error.message });
  }
  res.json({ user: data.user });
});

// Vehicle Entry
app.post('/entry', async (req, res) => {
  const { imageUrl, userId, numberPlate, spotId } = req.body;
  console.log('Entry request:', { imageUrl, userId, numberPlate, spotId });

  let finalNumberPlate = numberPlate;
  if (!finalNumberPlate && imageUrl) {
    const { data } = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const { data: { text } } = await Tesseract.recognize(Buffer.from(data), 'eng');
    finalNumberPlate = text.trim().replace(/^["“']+|["“']+$/g, '');
  }

  if (!finalNumberPlate) return res.status(400).json({ error: 'Number plate required' });

  const { data: spot, error: spotError } = await supabase
    .from('parking_spots')
    .select('id, status')
    .eq('id', spotId || null)
    .eq('status', 'available')
    .single();
  if (spotError || !spot) {
    const { data: availableSpot, error: availableError } = await supabase
      .from('parking_spots')
      .select('*')
      .eq('status', 'available')
      .limit(1)
      .single();
    if (availableError || !availableSpot) return res.status(400).json({ error: 'No available spot' });
    spot = availableSpot;
  }

  const vehicleData = {
    number_plate: finalNumberPlate,
    entry_time: new Date(),
    spot_id: spot.id,
    user_id: userId || null,
  };
  if (imageUrl) vehicleData.image_url = imageUrl;

  const { error } = await supabase.from('vehicles').insert([vehicleData]);
  if (error) return res.status(400).json({ error: error.message });

  await supabase
    .from('parking_spots')
    .update({ status: 'occupied' })
    .eq('id', spot.id);

  res.json({ message: 'Vehicle entered', numberPlate: finalNumberPlate, spotId: spot.id });
});

// Vehicle Registration
app.post('/register-vehicle', async (req, res) => {
  const { userId, numberPlate } = req.body;
  console.log('Register vehicle request:', { userId, numberPlate });

  if (!userId || !numberPlate) {
    return res.status(400).json({ error: 'userId and numberPlate are required' });
  }

  const { error } = await supabase
    .from('user_vehicles')
    .insert([{ user_id: userId, number_plate: numberPlate }]);
  if (error) return res.status(400).json({ error: error.message });

  await supabase
    .from('vehicles')
    .update({ user_id: userId })
    .eq('number_plate', numberPlate);

  res.status(201).json({ message: 'Vehicle registered' });
});

// Parking Spot Finder
app.get('/my-parkings', async (req, res) => {
  const { userId } = req.query;
  console.log('My parkings request:', { userId });

  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const { data: userVehicles, error: uvError } = await supabase
    .from('user_vehicles')
    .select('number_plate')
    .eq('user_id', userId);
  if (uvError) return res.status(400).json({ error: uvError.message });

  const numberPlates = userVehicles.map((uv) => uv.number_plate);
  if (!numberPlates.length) return res.json({ parkings: [] });

  const { data: parkings, error } = await supabase
    .from('vehicles')
    .select(`
      number_plate,
      entry_time,
      spot_id,
      parking_spots (
        id,
        location
      )
    `)
    .in('number_plate', numberPlates);
  if (error) return res.status(400).json({ error: error.message });

  const formattedParkings = parkings.map((parking) => ({
    number_plate: parking.number_plate,
    entry_time: parking.entry_time,
    spot_id: parking.spot_id,
    location: parking.parking_spots?.location || 'Unknown',
  }));

  res.json({ parkings: formattedParkings });
});

// Vehicle Exit
app.post('/exit', async (req, res) => {
  const { numberPlate } = req.body;
  console.log('Exit request:', { numberPlate });

  if (!numberPlate) return res.status(400).json({ error: 'numberPlate is required' });

  const { data: vehicle, error: vehicleError } = await supabase
    .from('vehicles')
    .select('id, entry_time, spot_id')
    .eq('number_plate', numberPlate)
    .is('exit_time', null)
    .single();
  if (vehicleError || !vehicle) return res.status(400).json({ error: 'Vehicle not found or already exited' });

  const entryTime = new Date(vehicle.entry_time);
  const exitTime = new Date();
  const durationMs = exitTime - entryTime;
  const durationHours = Math.round(durationMs / (1000 * 60 * 60) * 10) / 10;

  const ratePerHour = 10; // ₹10/hour
  const calculatedAmount = Math.ceil(durationHours * ratePerHour * 100); // In paise
  const amount = Math.max(calculatedAmount, 1000); // Minimum ₹10

  const { error: updateError } = await supabase
    .from('vehicles')
    .update({ exit_time: exitTime })
    .eq('id', vehicle.id);
  if (updateError) return res.status(400).json({ error: updateError.message });

  await supabase
    .from('parking_spots')
    .update({ status: 'available' })
    .eq('id', vehicle.spot_id);

  const shortVehicleId = vehicle.id.split('-')[0];
  const receipt = `exit_${shortVehicleId}`;

  try {
    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt,
    });

    res.json({
      numberPlate,
      entryTime,
      exitTime,
      durationHours,
      spotId: vehicle.spot_id,
      payment: {
        orderId: order.id,
        amount: amount / 100,
        currency: 'INR',
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create payment order: ' + err.message });
  }
});

// Admin Endpoints (No Auth)
app.get('/spots', async (req, res) => {
  const { data: spots, error } = await supabase.from('parking_spots').select('*');
  if (error) return res.status(400).json({ error: error.message });
  res.json({ spots });
});

app.get('/vehicles', async (req, res) => {
  const { data: vehicles, error } = await supabase
    .from('vehicles')
    .select('number_plate, entry_time, spot_id')
    .is('exit_time', null);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ vehicles });
});

app.get('/users', async (req, res) => {
  const { data: users, error: userError } = await supabase
    .from('users')
    .select('id, email, name');
  if (userError) return res.status(400).json({ error: userError.message });

  const { data: userVehicles, error: uvError } = await supabase
    .from('user_vehicles')
    .select('user_id, number_plate');
  if (uvError) return res.status(400).json({ error: uvError.message });

  const usersWithVehicles = users.map(user => ({
    ...user,
    vehicles: userVehicles.filter(uv => uv.user_id === user.id).map(uv => uv.number_plate),
  }));

  res.json({ users: usersWithVehicles });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));