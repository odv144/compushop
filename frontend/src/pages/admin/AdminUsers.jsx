import { useEffect, useState } from 'react';
import {
  Box, Heading, Table, Thead, Tbody, Tr, Th, Td, Badge, Spinner, Center, useColorModeValue, Text, IconButton, useToast, HStack,
} from '@chakra-ui/react';
import { FiTrash2 } from 'react-icons/fi';
import api from '../../api/client';

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const bg = useColorModeValue('white', 'gray.800');

  const load = () => {
    setLoading(true);
    api.get('/users').then(r => setUsers(r.data.users || [])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const remove = async (id) => {
    if (!confirm('¿Eliminar usuario?')) return;
    try {
      await api.delete(`/users/${id}`);
      toast({ title: 'Eliminado', status: 'info' });
      load();
    } catch (err) {
      toast({ title: 'Error', description: err.response?.data?.error, status: 'error' });
    }
  };

  if (loading) return <Center py={10}><Spinner /></Center>;

  return (
    <Box>
      <Heading size="lg" mb={6}>Usuarios</Heading>
      <Box bg={bg} borderRadius="xl" borderWidth="1px" overflowX="auto">
        <Table size="sm">
          <Thead><Tr><Th>Nombre</Th><Th>Email</Th><Th>DNI</Th><Th>Rol</Th><Th></Th></Tr></Thead>
          <Tbody>
            {users.map(u => (
              <Tr key={u.id}>
                <Td>{u.name}</Td>
                <Td>{u.email}</Td>
                <Td>{u.dni || '—'}</Td>
                <Td><Badge colorScheme={u.role === 'admin' ? 'purple' : 'gray'}>{u.role}</Badge></Td>
                <Td>
                  {u.role !== 'admin' && (
                    <IconButton size="sm" icon={<FiTrash2 />} colorScheme="red" variant="ghost" onClick={() => remove(u.id)} aria-label="Eliminar" />
                  )}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>
    </Box>
  );
}
