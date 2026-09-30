import { useEffect, useState } from 'react';
import {
  Box, Heading, Table, Thead, Tbody, Tr, Th, Td, Select, Badge, Spinner, Center, useColorModeValue, useToast, Text,
} from '@chakra-ui/react';
import api from '../../api/client';

const formatPrice = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);
const statuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];

export default function AdminOrders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const bg = useColorModeValue('white', 'gray.800');

  const load = () => {
    setLoading(true);
    api.get('/orders?limit=50').then(r => setOrders(r.data.orders || [])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const changeStatus = async (id, status) => {
    try {
      await api.put(`/orders/${id}/status`, { status });
      toast({ title: 'Estado actualizado', status: 'success' });
      load();
    } catch (err) {
      toast({ title: 'Error', status: 'error' });
    }
  };

  if (loading) return <Center py={10}><Spinner /></Center>;

  return (
    <Box>
      <Heading size="lg" mb={6}>Pedidos</Heading>
      <Box bg={bg} borderRadius="xl" borderWidth="1px" overflowX="auto">
        <Table size="sm">
          <Thead><Tr><Th>Nº</Th><Th>Cliente</Th><Th>Total</Th><Th>Estado</Th><Th>Fecha</Th></Tr></Thead>
          <Tbody>
            {orders.map(o => (
              <Tr key={o.id}>
                <Td fontFamily="mono">{o.order_number}</Td>
                <Td>
                  <Text>{o.customer_name}</Text>
                  <Text fontSize="xs" color="gray.500">{o.customer_email}</Text>
                </Td>
                <Td>{formatPrice(o.total)}</Td>
                <Td>
                  <Select size="sm" value={o.status} onChange={e => changeStatus(o.id, e.target.value)} maxW="140px">
                    {statuses.map(s => <option key={s} value={s}>{s}</option>)}
                  </Select>
                </Td>
                <Td>{new Date(o.created_at).toLocaleString('es-AR')}</Td>
              </Tr>
            ))}
            {orders.length === 0 && <Tr><Td colSpan={5}><Text textAlign="center" color="gray.500" py={4}>Sin pedidos</Text></Td></Tr>}
          </Tbody>
        </Table>
      </Box>
    </Box>
  );
}
