import { Navigate, Route, Routes } from 'react-router-dom';
import Shell from './components/Shell';
import AuditPage from './pages/AuditPage';
import CustomersPage from './pages/CustomersPage';
import InboxPage from './pages/InboxPage';
import LoginPage from './pages/LoginPage';
import MoneyPage from './pages/MoneyPage';
import SettingsPage from './pages/SettingsPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Shell />}>
        <Route path="/" element={<Navigate to="/inbox" replace />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/money" element={<MoneyPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
