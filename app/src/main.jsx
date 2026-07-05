// src/main.jsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './lib/auth.jsx';
import App from './App.jsx';
import Scan from './routes/Scan.jsx';
import './styles/app.css';

// Scan routes render full-screen (no admin shell). Everything else goes
// through App, which provides the sidebar layout and admin routing.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/s/:token" element={<Scan />} />
          <Route path="/s/:orgId/:token" element={<Scan />} />
          <Route path="/*" element={<App />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
