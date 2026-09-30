import { useEffect, useState } from 'react';
import {
  Box, Heading, VStack, Text, Badge, Button, Spinner, Center, useColorModeValue, HStack, useToast,
} from '@chakra-ui/react';
import api from '../../api/client';

export default function AdminMessages() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const bg = useColorModeValue('white', 'gray.800');

  const load = () => {
    setLoading(true);
    api.get('/contact').then(r => setMessages(r.data.messages || [])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const markRead = async (id) => {
    await api.put(`/contact/${id}/read`);
    toast({ title: 'Marcado como leído', status: 'success', duration: 1500 });
    load();
  };

  if (loading) return <Center py={10}><Spinner /></Center>;

  return (
    <Box>
      <Heading size="lg" mb={6}>Mensajes de contacto</Heading>
      <VStack spacing={4} align="stretch">
        {messages.map(m => (
          <Box key={m.id} bg={bg} p={5} borderRadius="xl" borderWidth="1px" borderLeftWidth="4px"
            borderLeftColor={m.is_read ? 'gray.300' : 'brand.500'}>
            <HStack justify="space-between" mb={2}>
              <Text fontWeight="bold">{m.name} · {m.email}</Text>
              <HStack>
                {!m.is_read && <Badge colorScheme="blue">Nuevo</Badge>}
                <Text fontSize="xs" color="gray.500">{new Date(m.created_at).toLocaleString('es-AR')}</Text>
              </HStack>
            </HStack>
            {m.subject && <Text fontSize="sm" fontWeight="medium" mb={1}>{m.subject}</Text>}
            <Text fontSize="sm" whiteSpace="pre-wrap">{m.message}</Text>
            {m.phone && <Text fontSize="xs" color="gray.500" mt={2}>Tel: {m.phone}</Text>}
            {!m.is_read && (
              <Button size="xs" mt={3} onClick={() => markRead(m.id)}>Marcar leído</Button>
            )}
          </Box>
        ))}
        {messages.length === 0 && <Text color="gray.500" textAlign="center">No hay mensajes</Text>}
      </VStack>
    </Box>
  );
}
