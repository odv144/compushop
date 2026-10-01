import { useState } from 'react';
import {
  Box, Container, Heading, VStack, HStack, Text, Button, Image, IconButton,
  Divider, Input, FormControl, FormLabel, useToast, useColorModeValue, NumberInput, NumberInputField, NumberInputStepper, NumberIncrementStepper, NumberDecrementStepper,
} from '@chakra-ui/react';
import { FiTrash2 } from 'react-icons/fi';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import api from '../api/client';
import { useNavigate } from 'react-router-dom';
import { formatPrice } from '../utils/format';

export default function Cart() {
  const { items, removeItem, updateQuantity, clearCart, totalPrice } = useCart();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const bg = useColorModeValue('white', 'gray.800');
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    customer_name: user?.name || '',
    customer_email: user?.email || '',
    customer_phone: user?.phone || '',
    shipping_address: user?.address || '',
    notes: '',
  });

  const handleConfirm = async () => {
    if (!form.customer_name || !form.customer_email) {
      toast({ title: 'Completá nombre y email', status: 'warning' });
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post('/orders', {
        items: items.map(i => ({ id: i.id, name: i.name, price: i.price, quantity: i.quantity, type: i.type })),
        ...form,
      });
      clearCart();
      toast({ title: '¡Pedido confirmado!', description: `Nº ${data.order.order_number}`, status: 'success', duration: 5000 });
      navigate('/');
    } catch (err) {
      toast({ title: 'Error', description: err.response?.data?.error || 'No se pudo confirmar', status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  if (items.length === 0) {
    return (
      <Container maxW="3xl" py={20} textAlign="center">
        <Heading size="md" mb={4}>Tu carrito está vacío</Heading>
        <Button colorScheme="brand" onClick={() => navigate('/productos')}>Ver productos</Button>
      </Container>
    );
  }

  return (
    <Container maxW="5xl" py={10}>
      <Heading mb={8}>Carrito de compras</Heading>
      <HStack align="start" spacing={8} flexDir={{ base: 'column', lg: 'row' }}>
        <VStack flex="1" spacing={4} w="100%">
          {items.map(item => (
            <Box key={`${item.type}-${item.id}`} bg={bg} p={4} borderRadius="lg" borderWidth="1px" w="100%">
              <HStack spacing={4}>
                <Image src={item.image} boxSize="80px" objectFit="cover" borderRadius="md" fallbackSrc="https://via.placeholder.com/80" />
                <VStack align="start" flex="1" spacing={1}>
                  <Text fontWeight="semibold">{item.name}</Text>
                  <Text fontSize="sm" color="gray.500">{item.type === 'service' ? 'Servicio' : 'Producto'}</Text>
                  <Text color="brand.500" fontWeight="bold">{formatPrice(item.price)}</Text>
                </VStack>
                <NumberInput size="sm" maxW="100px" value={item.quantity} min={1}
                  onChange={(_, v) => updateQuantity(item.id, item.type, v)}>
                  <NumberInputField />
                  <NumberInputStepper>
                    <NumberIncrementStepper />
                    <NumberDecrementStepper />
                  </NumberInputStepper>
                </NumberInput>
                <IconButton icon={<FiTrash2 />} variant="ghost" colorScheme="red" aria-label="Quitar"
                  onClick={() => removeItem(item.id, item.type)} />
              </HStack>
            </Box>
          ))}
        </VStack>

        <Box bg={bg} p={6} borderRadius="xl" borderWidth="1px" w={{ base: '100%', lg: '360px' }} position="sticky" top="80px">
          <Heading size="md" mb={4}>Resumen</Heading>
          <HStack justify="space-between" mb={2}>
            <Text>Subtotal</Text>
            <Text fontWeight="bold">{formatPrice(totalPrice)}</Text>
          </HStack>
          <Divider my={4} />
          <VStack spacing={3} mb={6}>
            <FormControl isRequired>
              <FormLabel fontSize="sm">Nombre</FormLabel>
              <Input size="sm" value={form.customer_name} onChange={e => setForm({ ...form, customer_name: e.target.value })} />
            </FormControl>
            <FormControl isRequired>
              <FormLabel fontSize="sm">Email</FormLabel>
              <Input size="sm" type="email" value={form.customer_email} onChange={e => setForm({ ...form, customer_email: e.target.value })} />
            </FormControl>
            <FormControl>
              <FormLabel fontSize="sm">Teléfono</FormLabel>
              <Input size="sm" value={form.customer_phone} onChange={e => setForm({ ...form, customer_phone: e.target.value })} />
            </FormControl>
            <FormControl>
              <FormLabel fontSize="sm">Dirección de envío</FormLabel>
              <Input size="sm" value={form.shipping_address} onChange={e => setForm({ ...form, shipping_address: e.target.value })} />
            </FormControl>
            <FormControl>
              <FormLabel fontSize="sm">Notas</FormLabel>
              <Input size="sm" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
            </FormControl>
          </VStack>
          <Button colorScheme="brand" size="lg" w="100%" isLoading={loading} onClick={handleConfirm}>
            Confirmar pedido
          </Button>
        </Box>
      </HStack>
    </Container>
  );
}
