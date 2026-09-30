import { useState } from 'react';
import {
  Box, Container, Heading, VStack, FormControl, FormLabel, Input, Button, Text, Link,
  useToast, useColorModeValue, SimpleGrid,
} from '@chakra-ui/react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Register() {
  const [form, setForm] = useState({ name: '', email: '', password: '', dni: '', phone: '', address: '' });
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const bg = useColorModeValue('white', 'gray.800');
  const border = useColorModeValue('gray.100', 'gray.700');
  const muted = useColorModeValue('gray.600', 'gray.400');
  const pageBg = useColorModeValue('surface.light', 'gray.900');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handle = async (e) => {
    e.preventDefault();
    if (form.password.length < 6) {
      toast({ title: 'La contraseña debe tener al menos 6 caracteres', status: 'warning' });
      return;
    }
    setLoading(true);
    try {
      await register(form);
      toast({ title: 'Cuenta creada', status: 'success' });
      navigate('/');
    } catch (err) {
      toast({
        title: 'Error',
        description: err.response?.data?.error || 'No se pudo registrar',
        status: 'error',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box minH="calc(100vh - 80px)" bg={pageBg} py={{ base: 10, md: 16 }}>
      <Container maxW="lg">
        <Box bg={bg} p={{ base: 6, md: 8 }} borderRadius="2xl" shadow="lg" borderWidth="1px" borderColor={border}>
          <VStack spacing={1} mb={6} textAlign="center">
            <Heading size="lg">Crear cuenta</Heading>
            <Text fontSize="sm" color={muted}>Registrate para comprar y seguir tus pedidos</Text>
          </VStack>
          <form onSubmit={handle}>
            <VStack spacing={4}>
              <FormControl isRequired>
                <FormLabel>Nombre completo</FormLabel>
                <Input value={form.name} onChange={set('name')} size="lg" />
              </FormControl>
              <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} w="100%">
                <FormControl isRequired>
                  <FormLabel>Email</FormLabel>
                  <Input type="email" value={form.email} onChange={set('email')} size="lg" />
                </FormControl>
                <FormControl>
                  <FormLabel>DNI</FormLabel>
                  <Input value={form.dni} onChange={set('dni')} size="lg" placeholder="Para recuperar clave" />
                </FormControl>
              </SimpleGrid>
              <FormControl isRequired>
                <FormLabel>Contraseña</FormLabel>
                <Input type="password" value={form.password} onChange={set('password')} size="lg" minLength={6} />
              </FormControl>
              <FormControl>
                <FormLabel>Teléfono</FormLabel>
                <Input value={form.phone} onChange={set('phone')} size="lg" />
              </FormControl>
              <FormControl>
                <FormLabel>Dirección</FormLabel>
                <Input value={form.address} onChange={set('address')} size="lg" />
              </FormControl>
              <Button type="submit" colorScheme="brand" w="100%" size="lg" isLoading={loading}>
                Registrarse
              </Button>
              <Text fontSize="sm" color={muted}>
                ¿Ya tenés cuenta?{' '}
                <Link as={RouterLink} to="/login" color="brand.500" fontWeight="600">Ingresá</Link>
              </Text>
            </VStack>
          </form>
        </Box>
      </Container>
    </Box>
  );
}
