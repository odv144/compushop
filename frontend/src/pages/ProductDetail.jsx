import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Box, Container, Heading, Text, Image, Button, HStack, VStack, Badge, Spinner, Center,
  SimpleGrid, useToast, useColorModeValue, List, ListItem,
} from '@chakra-ui/react';
import { FiShoppingCart } from 'react-icons/fi';
import api from '../api/client';
import { useCart } from '../context/CartContext';

const formatPrice = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

export default function ProductDetail() {
  const { id } = useParams();
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const { addItem } = useCart();
  const toast = useToast();
  const bg = useColorModeValue('white', 'gray.800');

  useEffect(() => {
    api.get(`/products/${id}`).then(r => setProduct(r.data.product))
      .catch(() => setProduct(null)).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <Center py={20}><Spinner size="xl" color="brand.500" /></Center>;
  if (!product) return <Center py={20}><Text>Producto no encontrado</Text></Center>;

  const handleAdd = () => {
    addItem(product, 1, 'product');
    toast({ title: 'Agregado al carrito', status: 'success', duration: 2000 });
  };

  return (
    <Container maxW="6xl" py={10}>
      <SimpleGrid columns={{ base: 1, md: 2 }} spacing={10}>
        <Box bg={bg} borderRadius="xl" overflow="hidden" borderWidth="1px">
          <Image src={product.image} alt={product.name} w="100%" maxH="420px" objectFit="cover"
            fallbackSrc="https://via.placeholder.com/600x400?text=Compushop" />
        </Box>
        <VStack align="start" spacing={4}>
          {product.brand && <Badge colorScheme="blue">{product.brand}</Badge>}
          <Heading size="lg">{product.name}</Heading>
          <Text fontSize="2xl" fontWeight="bold" color="brand.500">{formatPrice(product.price)}</Text>
          <Text color="gray.500">{product.description}</Text>
          {product.stock !== undefined && (
            <Text fontSize="sm" color={product.stock > 0 ? 'green.500' : 'red.500'}>
              {product.stock > 0 ? `Stock: ${product.stock} unidades` : 'Sin stock'}
            </Text>
          )}
          {product.specs && (
            <Box>
              <Text fontWeight="semibold" mb={2}>Especificaciones</Text>
              <List spacing={1} fontSize="sm">
                {Object.entries(product.specs).map(([k, v]) => (
                  <ListItem key={k}><b>{k}:</b> {String(v)}</ListItem>
                ))}
              </List>
            </Box>
          )}
          <Button leftIcon={<FiShoppingCart />} colorScheme="brand" size="lg" onClick={handleAdd}
            isDisabled={product.stock === 0}>
            Agregar al carrito
          </Button>
        </VStack>
      </SimpleGrid>
    </Container>
  );
}
