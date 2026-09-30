import { Routes, Route, Navigate } from 'react-router-dom';
import { Box } from '@chakra-ui/react';
import Navbar from './components/Navbar';
import Home from './pages/Home';
import Products from './pages/Products';
import ProductDetail from './pages/ProductDetail';
import Services from './pages/Services';
import Cart from './pages/Cart';
import Login from './pages/Login';
import Register from './pages/Register';
import Contact from './pages/Contact';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import AdminLayout from './pages/admin/AdminLayout';
import Dashboard from './pages/admin/Dashboard';
import AdminProducts from './pages/admin/AdminProducts';
import AdminServices from './pages/admin/AdminServices';
import AdminOrders from './pages/admin/AdminOrders';
import AdminUsers from './pages/admin/AdminUsers';
import AdminMessages from './pages/admin/AdminMessages';
import AdminSettings from './pages/admin/AdminSettings';
import { useAuth } from './context/AuthContext';

function PrivateAdmin({ children }) {
  const { user, loading, isAdmin } = useAuth();
  if (loading) return null;
  if (!user || !isAdmin) return <Navigate to="/login" replace state={{ from: '/admin' }} />;
  return children;
}

export default function App() {
  return (
    <Box minH="100vh">
      <Navbar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/productos" element={<Products />} />
        <Route path="/producto/:id" element={<ProductDetail />} />
        <Route path="/servicios" element={<Services />} />
        <Route path="/carrito" element={<Cart />} />
        <Route path="/login" element={<Login />} />
        <Route path="/registro" element={<Register />} />
        <Route path="/contacto" element={<Contact />} />
        <Route path="/recuperar-clave" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        <Route path="/admin" element={<PrivateAdmin><AdminLayout /></PrivateAdmin>}>
          <Route index element={<Dashboard />} />
          <Route path="productos" element={<AdminProducts />} />
          <Route path="servicios" element={<AdminServices />} />
          <Route path="pedidos" element={<AdminOrders />} />
          <Route path="usuarios" element={<AdminUsers />} />
          <Route path="mensajes" element={<AdminMessages />} />
          <Route path="configuracion" element={<AdminSettings />} />
        </Route>
      </Routes>
    </Box>
  );
}
