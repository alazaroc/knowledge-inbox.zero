import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { configureAmplify } from './lib/amplify';
import { AuthProvider } from './context/AuthContext';
import { ReloadPrompt } from './components/ReloadPrompt';
import ProtectedRoute from './components/ProtectedRoute';
import AppLayout from './pages/app/AppLayout';
import LoginPage from './pages/auth/LoginPage';
import SignUpPage from './pages/auth/SignUpPage';
import LandingPage from './pages/LandingPage';
import ProfilePage from './pages/app/ProfilePage';
import SettingsPage from './pages/app/SettingsPage';
import AddContentPage from './pages/app/AddContentPage';
import LibraryPage from './pages/app/LibraryPage';
import DocumentDetailPage from './pages/app/DocumentDetailPage';

configureAmplify();

export default function App() {
  return (
    <AuthProvider>
      <ReloadPrompt />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignUpPage />} />

          <Route
            path="/app"
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<LibraryPage />} />
            <Route path="add" element={<AddContentPage />} />
            <Route path="library" element={<LibraryPage />} />
            <Route path="library/:documentId" element={<DocumentDetailPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
