// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

// --- Firebase Admin SDK Initialization ---
try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        // For production on Render, parse from environment variable
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        console.log("Initializing Firebase Admin SDK from environment variable.");
    } else {
        // For local development, load from file
        serviceAccount = require('./serviceAccountKey.json');
        console.log("Initializing Firebase Admin SDK from local serviceAccountKey.json.");
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
      // databaseURL: "https://<YOUR_PROJECT_ID>.firebaseio.com" // If needed
    });
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
    console.error("Error initializing Firebase Admin SDK:", error);
    process.exit(1); // Exit if Firebase Admin can't be initialized, critical for app function
}
// -----------------------------------------

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // To parse JSON request bodies
app.use(express.static(path.join(__dirname, 'build'))); 

// Get a reference to Firestore
const db = admin.firestore();

// --- Authentication Middleware ---
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Unauthorized: No token provided' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken; // Add user info (uid, email, etc.) to request object
        console.log("Token verified for UID:", req.user.uid); // Log successful verification
        next(); // Proceed to the next middleware or route handler
    } catch (error) {
        console.error('Error verifying token:', error.code, error.message);
        // Provide more specific error messages based on Firebase error codes
        if (error.code === 'auth/id-token-expired') {
            return res.status(401).json({ message: 'Unauthorized: Token expired' });
        }
        return res.status(403).json({ message: 'Forbidden: Invalid token' });
    }
};

// --- API Endpoints ---

// GET all missions (Public)
app.get('/api/missions', async (req, res) => {
  try {
    const missionsRef = db.collection('missions');
    const snapshot = await missionsRef.orderBy('name', 'asc').get();

    if (snapshot.empty) {
      return res.status(404).json({ message: "No missions found" });
    }

    const missions = [];
    snapshot.forEach(doc => {
      missions.push({ id: doc.id, ...doc.data() });
    });

    res.status(200).json(missions);
  } catch (error) {
    console.error("Error fetching missions:", error);
    res.status(500).json({ message: "Failed to fetch missions", error: error.message });
  }
});

// GET user status (Protected) - including activeMission and shipStatus
app.get('/api/user/status', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const userDocRef = db.collection('users').doc(userId);
        const docSnap = await userDocRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ message: "User profile not found." });
        }

        const userData = docSnap.data();
        let activeMission = userData.activeMission || null;

        // Convert Firestore Timestamp to ISO string for client if activeMission exists
        if (activeMission && activeMission.startDate && activeMission.startDate.toDate) {
            activeMission.startDate = activeMission.startDate.toDate().toISOString();
        }
        
        res.status(200).json({
            activeMission: activeMission,
            shipStatus: userData.shipStatus || null // Or your INITIAL_SHIP_STATUS
        });

    } catch (error) {
        console.error("Error fetching user status:", error);
        res.status(500).json({ message: "Failed to fetch user status", error: error.message });
    }
});

// GET journey log for the authenticated user (Protected)
app.get('/api/user/journey-log', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        console.log(`GET /api/user/journey-log hit for User UID: ${userId}`);
        
        const journeyEventsRef = db.collection('users').doc(userId).collection('journeyEvents');
        const q = journeyEventsRef.orderBy('eventDate', 'desc');
        const querySnapshot = await q.get();
        
        if (querySnapshot.empty) {
            return res.status(200).json([]);
        }
        
        const journeyEvents = [];
        querySnapshot.forEach(doc => {
            const data = doc.data();
            
            // Convert Firestore Timestamp to ISO string
            if (data.eventDate && data.eventDate.toDate) {
                data.eventDate = data.eventDate.toDate().toISOString();
            }
            
            journeyEvents.push({
                id: doc.id,
                ...data
            });
        });
        
        console.log(`Retrieved ${journeyEvents.length} journey events for user ${userId}`);
        return res.status(200).json(journeyEvents);
        
    } catch (error) {
        console.error("Error in /api/user/journey-log:", error.message);
        return res.status(500).json({ message: error.message || "Server error fetching journey log." });
    }
});

// POST to start a mission (Protected)
app.post('/api/missions/start', verifyToken, async (req, res) => {
    try {
        console.log('POST /api/missions/start hit. Body:', req.body, 'User UID:', req.user.uid);
        const { missionId } = req.body;
        const userId = req.user.uid; // UID from verified token

        if (!missionId) {
            return res.status(400).json({ message: "Mission ID is required." });
        }

        const userDocRef = db.collection('users').doc(userId);
        const missionDocRef = db.collection('missions').doc(missionId);

        let activeMissionToReturn;

        // Run as a transaction to ensure atomicity
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userDocRef);
            const missionDoc = await transaction.get(missionDocRef);

            if (!userDoc.exists) {
                throw new Error("User profile not found in Firestore.");
            }
            if (!missionDoc.exists) {
                throw new Error("Mission details not found in Firestore.");
            }

            const userData = userDoc.data();
            const missionData = missionDoc.data();

            if (userData.activeMission) {
                throw new Error("User already has an active mission.");
            }

            // Ensure shipStatus exists and has crewCurrent
            if (!userData.shipStatus || typeof userData.shipStatus.crewCurrent === 'undefined') {
                console.error(`User ${userId} missing shipStatus or crewCurrent`);
                throw new Error("Ship status data is incomplete for user.");
            }
             // Ensure missionData has crew requirement
            if (typeof missionData.crew === 'undefined') {
                console.error(`Mission ${missionId} missing crew requirement`);
                throw new Error("Mission data is incomplete (missing crew requirement).");
            }


            if (userData.shipStatus.crewCurrent < missionData.crew) {
                throw new Error(`Insufficient crew. Required: ${missionData.crew}, Available: ${userData.shipStatus.crewCurrent}`);
            }

            const newActiveMission = {
                missionId: missionId,
                missionName: missionData.name,
                startDate: admin.firestore.FieldValue.serverTimestamp(), // Use server timestamp
                durationSeconds: missionData.durationSeconds
            };

            transaction.update(userDocRef, { activeMission: newActiveMission });
            
            // We will set activeMissionToReturn *after* the transaction for the most up-to-date data
            // or we can construct it here if serverTimestamp() is problematic for immediate return.
            // For simplicity and to ensure client gets the structure, let's prepare it.
            // However, the actual startDate from serverTimestamp will only be known after commit.
            activeMissionToReturn = {
                missionId: newActiveMission.missionId,
                missionName: newActiveMission.missionName,
                // startDate will be populated after fetching again or client can approximate
                durationSeconds: newActiveMission.durationSeconds
            };

            // Log the "started" journey event
            const journeyEventsRef = userDocRef.collection('journeyEvents');
            transaction.set(journeyEventsRef.doc(), {
                missionId: missionId,
                missionName: missionData.name,
                status: 'started',
                eventDate: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        
        // After transaction, fetch the user document again to get the actual startDate
        const updatedUserDoc = await userDocRef.get();
        const finalActiveMission = updatedUserDoc.data().activeMission;
        
        if (finalActiveMission && finalActiveMission.startDate && finalActiveMission.startDate.toDate) {
             finalActiveMission.startDate = finalActiveMission.startDate.toDate().toISOString();
        }


        return res.status(200).json({
            message: "Mission started successfully",
            activeMission: finalActiveMission // Return the mission data with the server-generated timestamp
        });

    } catch (error) {
        console.error("Error in /api/missions/start:", error.message);
        const isClientError = error.message.includes("User already") ||
                              error.message.includes("Insufficient crew") ||
                              error.message.includes("not found") ||
                              error.message.includes("required") ||
                              error.message.includes("incomplete");
        
        return res.status(isClientError ? 400 : 500)
                  .json({ message: error.message || "Server error starting mission." });
    }
});

// POST to cancel an active mission (Protected)
app.post('/api/missions/cancel', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        console.log(`POST /api/missions/cancel hit for User UID: ${userId}`);

        const userDocRef = db.collection('users').doc(userId);
        let CanceledMissionName = "Unknown Mission"; 
        let CanceledMissionId = null;

        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userDocRef);
            if (!userDoc.exists) throw new Error("User profile not found.");

            const userData = userDoc.data();
            if (!userData.activeMission) throw new Error("No active mission to cancel.");

            CanceledMissionName = userData.activeMission.missionName;
            CanceledMissionId = userData.activeMission.missionId;

            transaction.update(userDocRef, { activeMission: admin.firestore.FieldValue.delete() });

            const journeyEventsRef = userDocRef.collection('journeyEvents');
            transaction.set(journeyEventsRef.doc(), {
                missionId: CanceledMissionId,
                missionName: CanceledMissionName,
                status: 'canceled',
                eventDate: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        console.log(`Mission ${CanceledMissionId} canceled successfully for user ${userId}.`);
        return res.status(200).json({ message: `Mission "${CanceledMissionName}" canceled successfully.` });

    } catch (error) {
        console.error("Error in /api/missions/cancel:", error.message);
        const isClientError = error.message.includes("No active mission") || error.message.includes("not found");
        return res.status(isClientError ? 400 : 500).json({ message: error.message || "Server error canceling mission." });
    }
});

// POST to complete a mission (Protected)
app.post('/api/missions/complete', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { missionId, missionName } = req.body; // Client should send these

        console.log(`POST /api/missions/complete hit for User UID: ${userId}, Mission ID: ${missionId}`);

        if (!missionId || !missionName) {
            return res.status(400).json({ message: "Mission ID and Mission Name are required." });
        }

        const userDocRef = db.collection('users').doc(userId);

        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userDocRef);
            if (!userDoc.exists) throw new Error("User profile not found.");

            const userData = userDoc.data();
            if (!userData.activeMission) {
                console.warn(`User ${userId} tried to complete mission ${missionId}, but no active mission found in DB.`);
                throw new Error("No active mission found to complete. It might have been canceled or already completed.");
            }
            if (userData.activeMission.missionId !== missionId) {
                console.warn(`Mismatch: DB active mission is ${userData.activeMission.missionId}, client sent ${missionId} for completion.`);
                throw new Error("The mission to complete does not match the currently active mission in the database.");
            }
            
            transaction.update(userDocRef, { activeMission: admin.firestore.FieldValue.delete() });

            const journeyEventsRef = userDocRef.collection('journeyEvents');
            transaction.set(journeyEventsRef.doc(), {
                missionId: missionId,
                missionName: missionName,
                status: 'completed',
                eventDate: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        console.log(`Mission ${missionId} completed successfully for user ${userId}.`);
        return res.status(200).json({ message: `Mission "${missionName}" completed successfully.` });

    } catch (error) {
        console.error("Error in /api/missions/complete:", error.message);
        const isClientError = error.message.includes("required") || error.message.includes("not found") || error.message.includes("does not match") || error.message.includes("No active mission found to complete");
        return res.status(isClientError ? 400 : 500).json({ message: error.message || "Server error completing mission." });
    }
});

// --- Test Routes (can be removed or commented out for production) ---
app.get('/api/test-firestore', async (req, res) => {
  try {
    const collections = await db.listCollections();
    const collectionNames = collections.map(col => col.id);
    res.json({
        message: "Firestore connection test successful!",
        collections: collectionNames
    });
  } catch (error) {
    console.error("Firestore test error:", error);
    res.status(500).json({ message: "Error connecting to Firestore", error: error.message });
  }
});

app.get('/api/test', (req, res) => {
  res.json({ message: "Hello from the Space Simulator Backend!" });
});

app.get(/(.*)/, (req, res) => {
    // Adjust path if your build folder is not directly in __dirname
    res.sendFile(path.join(__dirname, 'build', 'index.html')); 
});

// -------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  // If serving static files, you might also log:
  console.log(`Frontend static files are being served from 'build' directory.`);
});