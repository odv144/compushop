import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import {
  Box, Flex, VStack, Text, Button, useColorModeValue, Container, Heading, Icon,
} from '@chakra-ui/react';
import {
  FiHome, FiPackage, FiTool, FiShoppingBag, FiUsers, FiMail, FiSettings, FiArrowLeft,
} from 'react-icons/fi';

const links = [
  { to: '/admin', label: 'Dashboard', icon: FiHome, end: true },
  { to: '/admin/productos', label: 'Productos', icon: FiPackage },
  { to: '/admin/servicios', label: 'Servicios', icon: FiTool },
  { to: '/admin/pedidos', label: 'Pedidos', icon: FiShoppingBag },
  { to: '/admin/usuarios', label: 'Usuarios', icon: FiUsers },
  { to: '/admin/mensajes', label: 'Mensajes', icon: FiMail },
  { to: '/admin/configuracion', label: 'Configuración', icon: FiSettings },
];

export default function AdminLayout() {
  const bg = useColorModeValue('white', 'gray.800');
  const border = useColorModeValue('gray.200', 'gray.700');
  const navigate = useNavigate();

  return (
    <Flex minH="calc(100vh - 64px)">
      <Box w="240px" bg={bg} borderRight="1px" borderColor={border} p={4} display={{ base: 'none', md: 'block' }}>
        <Heading size="sm" mb={6} color="brand.500">Admin</Heading>
        <VStack align="stretch" spacing={1}>
          {links.map(l => (
            <Button
              key={l.to}
              as={NavLink}
              to={l.to}
              end={l.end}
              variant="ghost"
              justifyContent="flex-start"
              leftIcon={<Icon as={l.icon} />}
              size="sm"
              _activeLink={{ bg: 'brand.50', color: 'brand.600', fontWeight: 'bold' }}
            >
              {l.label}
            </Button>
          ))}
        </VStack>
        <Button mt={8} size="sm" variant="outline" leftIcon={<FiArrowLeft />} onClick={() => navigate('/')}>
          Volver a la tienda
        </Button>
      </Box>
      <Box flex="1" p={{ base: 4, md: 8 }} overflow="auto">
        <Container maxW="6xl" px={0}>
          <Outlet />
        </Container>
      </Box>
    </Flex>
  );
}
