const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Tesseract = require('tesseract.js');
const Razorpay = require('razorpay');
const cors = require('cors');
const axios = require('axios'); // Added for image download
const fs = require('fs'); // Added for file handling
require('dotenv').config();

const app = express();

const corsOptions = {
  origin: 'http://localhost:8080',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.get('/', (req, res) => res.send('ParkMate Backend'));

// Registration
app.post('/register', async (req, res) => {
    const { email, password, name, phone, role } = req.body;
    console.log('Register request:', { email, name, phone, role });
  
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      console.log('Auth signup error:', error);
      return res.status(400).json({ error: error.message });
    }
    console.log('Auth user created:', data.user.id);
  
    const { data: insertedUser, error: insertError } = await supabase
      .from('users')
      .insert([{ id: data.user.id, email, name, phone, role: role || 'user' }])
      .select()
      .single();
    if (insertError) {
      console.log('Users table insert error:', insertError);
      return res.status(400).json({ error: insertError.message });
    }
    console.log('User inserted into users table:', insertedUser.id);
  
    res.status(201).json({ message: 'User registered', user: data.user });
  });

// Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  console.log('Login request:', { email });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.log('Login error:', error);
    return res.status(400).json({ error: error.message });
  }
  res.json({ token: data.session.access_token, user: data.user });
});

// Vehicle Entry
app.post('/entry', async (req, res) => {
    const { imageUrl, userId } = req.body;
    console.log('Entry request:', { imageUrl, userId });
  
    if (!imageUrl) {
      return res.status(400).json({ error: 'imageUrl is required' });
    }
  
    let tempFile = 'temp.jpg';
    try {
      console.log('Downloading image from:', imageUrl);
      const response = await axios({
        url: imageUrl,
        method: 'GET',
        responseType: 'stream',
      }).catch((err) => {
        throw new Error('Failed to download image: ' + err.message);
      });
  
      const writer = fs.createWriteStream(tempFile);
      response.data.pipe(writer);
  
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
  
      console.log('Attempting to recognize image:', tempFile);
      const { data } = await Tesseract.recognize(tempFile, 'eng', {
        logger: (m) => console.log(m),
      });
      const numberPlate = data.text.trim().replace(/^["“']+|["“']+$/g, ''); // Remove leading/trailing quotes
      console.log('Recognized number plate:', numberPlate);
  
      const { data: spot, error: spotError } = await supabase
        .from('parking_spots')
        .select('*')
        .eq('status', 'available')
        .limit(1)
        .single();
      if (spotError || !spot) {
        console.log('Spot error:', spotError);
        return res.status(400).json({ error: 'No available spots' });
      }
  
      const vehicleData = {
        number_plate: numberPlate,
        image_url: imageUrl,
        entry_time: new Date(),
        spot_id: spot.id,
      };
      if (userId) vehicleData.user_id = userId;
  
      const { error } = await supabase.from('vehicles').insert([vehicleData]);
      if (error) {
        console.log('Insert error:', error);
        return res.status(400).json({ error: error.message });
      }
  
      const { data: updatedSpot, error: updateError } = await supabase
        .from('parking_spots')
        .update({ status: 'occupied' })
        .eq('id', spot.id)
        .select()
        .single();
      if (updateError) {
        console.log('Update error:', updateError);
        return res.status(500).json({ error: updateError.message });
      }
  
      res.json({ numberPlate, spot: updatedSpot });
    } catch (err) {
      console.error('Tesseract or processing error:', err.message);
      res.status(500).json({ error: 'Failed to process image: ' + err.message });
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
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
  if (error) {
    console.log('Insert error:', error);
    return res.status(400).json({ error: error.message });
  }

  // Update existing vehicle entries
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
  
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
  
    const { data: userVehicles, error: uvError } = await supabase
      .from('user_vehicles')
      .select('number_plate')
      .eq('user_id', userId);
    if (uvError) {
      console.log('User vehicles error:', uvError);
      return res.status(400).json({ error: uvError.message });
    }
  
    const numberPlates = userVehicles.map((uv) => uv.number_plate);
    if (!numberPlates.length) {
      return res.json({ parkings: [] });
    }
  
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
    if (error) {
      console.log('Parkings error:', error);
      return res.status(400).json({ error: error.message });
    }
  
    const formattedParkings = parkings.map((parking) => ({
      number_plate: parking.number_plate,
      entry_time: parking.entry_time,
      spot_id: parking.spot_id,
      location: parking.parking_spots?.location || 'Unknown',
    }));
  
    res.json({ parkings: formattedParkings });
  });

  //vehicle exit

  app.post('/exit', async (req, res) => {
  const { numberPlate } = req.body;
  console.log('Exit request:', { numberPlate });

  if (!numberPlate) {
    return res.status(400).json({ error: 'numberPlate is required' });
  }

  const { data: vehicle, error: vehicleError } = await supabase
    .from('vehicles')
    .select('id, entry_time, spot_id')
    .eq('number_plate', numberPlate)
    .is('exit_time', null)
    .single();
  if (vehicleError || !vehicle) {
    console.log('Vehicle error:', vehicleError);
    return res.status(400).json({ error: 'Vehicle not found or already exited' });
  }

  const entryTime = new Date(vehicle.entry_time);
  const exitTime = new Date();
  const durationMs = exitTime - entryTime;
  const durationHours = Math.round(durationMs / (1000 * 60 * 60) * 10) / 10;

  const ratePerHour = 10; // ₹10/hour
  const calculatedAmount = Math.ceil(durationHours * ratePerHour * 100); // In paise
  const amount = Math.max(calculatedAmount, 1000); // Minimum ₹10 (1000 paise)

  const { error: updateError } = await supabase
    .from('vehicles')
    .update({ exit_time: exitTime })
    .eq('id', vehicle.id);
  if (updateError) {
    console.log('Update error:', updateError);
    return res.status(400).json({ error: updateError.message });
  }

  await supabase
    .from('parking_spots')
    .update({ status: 'available' })
    .eq('id', vehicle.spot_id);

  const shortVehicleId = vehicle.id.split('-')[0];
  const receipt = `exit_${shortVehicleId}`;

  try {
    const order = await razorpay.orders.create({
      amount, // In paise, minimum 1000
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
        amount: amount / 100, // Convert back to INR
        currency: 'INR',
      },
    });
  } catch (err) {
    console.log('Razorpay error:', err);
    return res.status(500).json({ error: 'Failed to create payment order: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));