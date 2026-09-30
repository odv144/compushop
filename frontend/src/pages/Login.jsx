import { useState } from 'react';
import {
  Box, Container, Heading, VStack, FormControl, FormLabel, Input, Button, Text, Link,
  useToast, useColorModeValue, InputGroup, InputRightElement, IconButton,
} from '@chakra-ui/react';
import { Link as RouterLink, useNavigate, useLocation } from 'react-router-dom';
import { FiEye, FiEyeOff } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from || '/';

  const bg = useColorModeValue('white', 'gray.800');
  const border = useColorModeValue('gray.100', 'gray.700');
  const muted = useColorModeValue('gray.600', 'gray.400');
  const pageBg = useColorModeValue('surface.light', 'gray.900');

  const handle = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      toast({ title: 'Completá email y contraseña', status: 'warning', duration: 2500 });
      return;
    }
    setLoading(true);
    try {
      const data = await login(email.trim(), password);
      toast({
        title: `Bienvenido, ${data.user.name.split(' ')[0]}`,
        status: 'success',
        duration: 2000,
        isClosable: true,
      });
      const dest = data.user.role === 'admin' ? '/admin' : from;
      navigate(dest, { replace: true });
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Credenciales inválidas';
      toast({ title: 'Error al ingresar', description: msg, status: 'error', duration: 4000, isClosable: true });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box minH="calc(100vh - 80px)" bg={pageBg} py={{ base: 10, md: 16 }}>
      <Container maxW="md">
        <Box
          bg={bg}
          p={{ base: 6, md: 8 }}
          borderRadius="2xl"
          shadow="lg"
          borderWidth="1px"
          borderColor={border}
        >
          <VStack spacing={1} mb={6} textAlign="center">
            <Heading size="lg">Ingresar</Heading>
            <Text fontSize="sm" color={muted}>
              Accedé con tu cuenta Compushop
            </Text>
          </VStack>

          <form onSubmit={handle}>
            <VStack spacing={4}>
              <FormControl isRequired>
                <FormLabel>Email</FormLabel>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="tu@email.com"
                  autoComplete="email"
                  size="lg"
                />
              </FormControl>

              <FormControl isRequired>
                <FormLabel>Contraseña</FormLabel>
                <InputGroup size="lg">
                  <Input
                    type={showPass ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                  />
                  <InputRightElement>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={showPass ? 'Ocultar' : 'Mostrar'}
                      icon={showPass ? <FiEyeOff /> : <FiEye />}
                      onClick={() => setShowPass((v) => !v)}
                    />
                  </InputRightElement>
                </InputGroup>
              </FormControl>

              <Button
                type="submit"
                colorScheme="brand"
                w="100%"
                size="lg"
                isLoading={loading}
                loadingText="Ingresando..."
              >
                Ingresar
              </Button>

              <Text fontSize="sm" color={muted}>
                <Link as={RouterLink} to="/recuperar-clave" color="brand.500" fontWeight="600">
                  ¿Olvidaste tu clave?
                </Link>
              </Text>
              <Text fontSize="sm" color={muted}>
                ¿No tenés cuenta?{' '}
                <Link as={RouterLink} to="/registro" color="brand.500" fontWeight="600">
                  Registrate
                </Link>
              </Text>
            </VStack>
          </form>

          <Box mt={6} p={3} borderRadius="lg" bg={useColorModeValue('brand.50', 'whiteAlpha.100')} fontSize="xs" color={muted}>
            <Text fontWeight="600" mb={1}>Demo:</Text>
            <Text>Admin: admin@compushop.com / admin123</Text>
            <Text>Cliente: juan@email.com / cliente123</Text>
          </Box>
        </Box>
      </Container>
    </Box>
  );
}
