// public/escuela/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { initializeFirestore, memoryLocalCache } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD4MOeUZGrlbwrqSnTjRY9BT_-x8L6Hn3s",
  authDomain: "sebabru-e5563.firebaseapp.com",
  projectId: "sebabru-e5563",
  storageBucket: "sebabru-e5563.firebasestorage.app",
  messagingSenderId: "485871026732",
  appId: "1:485871026732:web:9083310f93687055f4c789",
  measurementId: "G-GDLRMR5D57"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// IMPORTANTE: Aquí forzamos la base de datos "cursos"
const db = initializeFirestore(app, {
    localCache: memoryLocalCache(),
    experimentalForceLongPolling: true,
    useFetchStreams: false
}, "cursos"); 

export { app, auth, db };