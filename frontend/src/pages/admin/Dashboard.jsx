import { useEffect, useState } from 'react';
import {
  SimpleGrid, Box, Stat, StatLabel, StatNumber, Heading, Text, Table, Thead, Tbody, Tr, Th, Td,
  Spinner, Center, useColorModeValue, Badge,
} from '@chakra-ui/react';
import api from '../../api/client';

const formatPrice = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n || 0);

export default function Dashboard() {
  const [data, setData] = useState(null);
  const bg = useColorModeValue('white', 'gray.800');

  useEffect(() => {
    api.get('/dashboard/stats').then(r => setData(r.data)).catch(console.error);
  }, []);

  if (!data) return <Center py={20}><Spinner size="xl" color="brand.500" /></Center>;

  const cards = [
    { label: 'Productos', value: data.stats.productsCount },
    { label: 'Servicios', value: data.stats.servicesCount },
    { label: 'Clientes', value: data.stats.usersCount },
    { label: 'Pedidos', value: data.stats.ordersCount },
    { label: 'Pendientes', value: data.stats.pendingOrders },
    { label: 'Mensajes sin leer', value: data.stats.unreadMessages },
    { label: 'Ingresos', value: formatPrice(data.stats.revenue) },
  ];

  return (
    <Box>
      <Heading size="lg" mb={6}>Dashboard</Heading>
      <SimpleGrid columns={{ base: 2, md: 4 }} spacing={4} mb={10}>
        {cards.map(c => (
          <Box key={c.label} bg={bg} p={5} borderRadius="xl" borderWidth="1px">
            <Stat>
              <StatLabel color="gray.500">{c.label}</StatLabel>
              <StatNumber fontSize="2xl">{c.value}</StatNumber>
            </Stat>
          </Box>
        ))}
      </SimpleGrid>

      <Heading size="md" mb={4}>Pedidos recientes</Heading>
      <Box bg={bg} borderRadius="xl" borderWidth="1px" overflow="hidden" mb={10}>
        <Table size="sm">
          <Thead>
            <Tr><Th>Nº</Th><Th>Cliente</Th><Th>Total</Th><Th>Estado</Th><Th>Fecha</Th></Tr>
          </Thead>
          <Tbody>
            {(data.recentOrders || []).map(o => (
              <Tr key={o.id}>
                <Td>{o.order_number}</Td>
                <Td>{o.customer_name}</Td>
                <Td>{formatPrice(o.total)}</Td>
                <Td><Badge>{o.status}</Badge></Td>
                <Td>{new Date(o.created_at).toLocaleDateString('es-AR')}</Td>
              </Tr>
            ))}
            {(!data.recentOrders || data.recentOrders.length === 0) && (
              <Tr><Td colSpan={5}><Text color="gray.500" textAlign="center" py={4}>Sin pedidos aún</Text></Td></Tr>
            )}
          </Tbody>
        </Table>
      </Box>

      {data.lowStock?.length > 0 && (
        <>
          <Heading size="md" mb={4}>Stock bajo</Heading>
          <Box bg={bg} borderRadius="xl" borderWidth="1px" overflow="hidden">
            <Table size="sm">
              <Thead><Tr><Th>Producto</Th><Th>Stock</Th><Th>Precio</Th></Tr></Thead>
              <Tbody>
                {data.lowStock.map(p => (
                  <Tr key={p.id}>
                    <Td>{p.name}</Td>
                    <Td><Badge colorScheme={p.stock === 0 ? 'red' : 'orange'}>{p.stock}</Badge></Td>
                    <Td>{formatPrice(p.price)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </Box>
        </>
      )}
    </Box>
  );
}
