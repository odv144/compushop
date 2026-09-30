import { useState } from 'react';
import {
  Box, Container, Heading, VStack, FormControl, FormLabel, Input, Textarea, Button, useToast, useColorModeValue, Text, SimpleGrid,
} from '@chakra-ui/react';
import api from '../api/client';

export default function Contact() {
  const [form, setForm] = useState({ name: '', email: '', phone: '', subject: '', message: '' });
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const bg = useColorModeValue('white', 'gray.800');

  const handle = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/contact', form);
      toast({ title: data.message, status: 'success', duration: 4000 });
      setForm({ name: '', email: '', phone: '', subject: '', message: '' });
    } catch (err) {
      toast({ title: 'Error', description: err.response?.data?.error || 'No se pudo enviar', status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container maxW="3xl" py={12}>
      <Heading mb={2}>Contacto</Heading>
      <Text color="gray.500" mb={8}>Escribinos y te respondemos a la brevedad.</Text>
      <Box bg={bg} p={8} borderRadius="xl" borderWidth="1px" shadow="sm">
        <form onSubmit={handle}>
          <VStack spacing={4}>
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} w="100%">
              <FormControl isRequired>
                <FormLabel>Nombre</FormLabel>
                <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
              </FormControl>
              <FormControl isRequired>
                <FormLabel>Email</FormLabel>
                <Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
              </FormControl>
            </SimpleGrid>
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} w="100%">
              <FormControl>
                <FormLabel>Teléfono</FormLabel>
                <Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
              </FormControl>
              <FormControl>
                <FormLabel>Asunto</FormLabel>
                <Input value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} />
              </FormControl>
            </SimpleGrid>
            <FormControl isRequired>
              <FormLabel>Mensaje</FormLabel>
              <Textarea rows={5} value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} />
            </FormControl>
            <Button type="submit" colorScheme="brand" size="lg" w="100%" isLoading={loading}>Enviar mensaje</Button>
          </VStack>
        </form>
      </Box>
    </Container>
  );
}
