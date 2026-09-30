import { useState } from 'react';
import { Box, Container, Heading, VStack, FormControl, FormLabel, Input, Button, useToast, useColorModeValue } from '@chakra-ui/react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '../api/client';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const bg = useColorModeValue('white', 'gray.800');

  const handle = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, newPassword });
      toast({ title: 'Contraseña actualizada', status: 'success' });
      navigate('/login');
    } catch (err) {
      toast({ title: 'Error', description: err.response?.data?.error, status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container maxW="md" py={16}>
      <Box bg={bg} p={8} borderRadius="xl" shadow="md" borderWidth="1px">
        <Heading size="lg" mb={6} textAlign="center">Nueva contraseña</Heading>
        <form onSubmit={handle}>
          <VStack spacing={4}>
            <FormControl isRequired>
              <FormLabel>Nueva contraseña</FormLabel>
              <Input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} minLength={6} />
            </FormControl>
            <Button type="submit" colorScheme="brand" w="100%" isLoading={loading} isDisabled={!token}>Guardar</Button>
          </VStack>
        </form>
      </Box>
    </Container>
  );
}
