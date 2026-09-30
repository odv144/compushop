import { useState } from 'react';
import { Box, Container, Heading, VStack, FormControl, FormLabel, Input, Button, Text, useToast, useColorModeValue, Code } from '@chakra-ui/react';
import api from '../api/client';
import { useNavigate } from 'react-router-dom';

export default function ForgotPassword() {
  const [dni, setDni] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [devToken, setDevToken] = useState(null);
  const toast = useToast();
  const navigate = useNavigate();
  const bg = useColorModeValue('white', 'gray.800');

  const handle = async (e) => {
    e.preventDefault();
    setLoading(true);
    setDevToken(null);
    try {
      const { data } = await api.post('/auth/forgot-password', { dni, email: email || undefined });
      toast({ title: data.message, status: 'info', duration: 5000 });
      if (data.dev_token) setDevToken(data.dev_token);
    } catch (err) {
      toast({ title: 'Error', description: err.response?.data?.error, status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container maxW="md" py={16}>
      <Box bg={bg} p={8} borderRadius="xl" shadow="md" borderWidth="1px">
        <Heading size="lg" mb={2} textAlign="center">Recuperar contraseña</Heading>
        <Text fontSize="sm" color="gray.500" mb={6} textAlign="center">Ingresá tu DNI para recibir un enlace de recuperación.</Text>
        <form onSubmit={handle}>
          <VStack spacing={4}>
            <FormControl isRequired>
              <FormLabel>DNI</FormLabel>
              <Input value={dni} onChange={e => setDni(e.target.value)} placeholder="30123456" />
            </FormControl>
            <FormControl>
              <FormLabel>Email (opcional, para validar)</FormLabel>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} />
            </FormControl>
            <Button type="submit" colorScheme="brand" w="100%" isLoading={loading}>Enviar</Button>
          </VStack>
        </form>
        {devToken && (
          <Box mt={6} p={4} bg="yellow.50" borderRadius="md" borderWidth="1px" borderColor="yellow.200">
            <Text fontSize="sm" mb={2}>Modo desarrollo – SMTP no configurado. Token:</Text>
            <Code fontSize="xs" wordBreak="break-all">{devToken}</Code>
            <Button mt={3} size="sm" onClick={() => navigate(`/reset-password?token=${devToken}`)}>Ir a restablecer</Button>
          </Box>
        )}
      </Box>
    </Container>
  );
}
