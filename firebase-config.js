import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyA1TwTb5H_jjpq8-h32ttj3GIvmWHNFz80",
  authDomain: "pokemon-auction-8f9c5.firebaseapp.com",
  databaseURL: "https://pokemon-auction-8f9c5-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "pokemon-auction-8f9c5",
  storageBucket: "pokemon-auction-8f9c5.firebasestorage.app",
  messagingSenderId: "185489201510",
  appId: "1:185489201510:web:68374926e77e4800d910a7",
  measurementId: "G-QGP9DD7SW9"
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);