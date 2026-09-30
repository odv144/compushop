import {
  Box, Image, Text, Badge, Button, VStack, useColorModeValue, useToast,
} from '@chakra-ui/react';
import { Link as RouterLink } from 'react-router-dom';
import { useCart } from '../context/CartContext';

const formatPrice = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

export default function ProductCard({ product, type = 'product' }) {
  const { addItem } = useCart();
  const toast = useToast();
  const bg = useColorModeValue('white', 'gray.800');
  const muted = useColorModeValue('gray.500', 'gray.400');

  const handleAdd = (e) => {
    e.preventDefault();
    e.stopPropagation();
    addItem(product, 1, type);
    toast({
      title: 'Agregado al carrito',
      status: 'success',
      duration: 2000,
      isClosable: true,
      position: 'top-right',
    });
  };

  const to = type === 'product'
    ? `/producto/${product.slug || product.id}`
    : `/servicio/${product.slug || product.id}`;

  return (
    <Box
      bg={bg}
      borderRadius="2xl"
      overflow="hidden"
      transition="all 0.25s ease"
      _hover={{ shadow: 'xl', transform: 'translateY(-6px)' }}
      h="100%"
      display="flex"
      flexDirection="column"
      border="1px solid"
      borderColor={useColorModeValue('blackAlpha.50', 'whiteAlpha.100')}
    >
      <Box
        as={RouterLink}
        to={to}
        position="relative"
        h="200px"
        bg={useColorModeValue('gray.50', 'gray.900')}
        overflow="hidden"
      >
        <Image
          src={product.image || 'https://via.placeholder.com/400x300?text=Compushop'}
          alt={product.name}
          objectFit="cover"
          w="100%"
          h="100%"
          transition="transform 0.3s"
          _groupHover={{ transform: 'scale(1.05)' }}
          fallbackSrc="https://via.placeholder.com/400x300?text=Compushop"
        />
        {type === 'product' && product.stock <= 5 && product.stock > 0 && (
          <Badge position="absolute" top={3} left={3} colorScheme="orange" borderRadius="full" px={3}>
            Últimas unidades
          </Badge>
        )}
        {type === 'product' && product.stock === 0 && (
          <Badge position="absolute" top={3} left={3} colorScheme="red" borderRadius="full" px={3}>
            Sin stock
          </Badge>
        )}
      </Box>

      <VStack p={5} align="stretch" spacing={3} flex="1">
        {product.brand && (
          <Text fontSize="xs" color={muted} textTransform="uppercase" letterSpacing="wider" fontWeight="600">
            {product.brand}
          </Text>
        )}
        <Text
          as={RouterLink}
          to={to}
          fontWeight="700"
          fontSize="lg"
          noOfLines={2}
          minH="56px"
          lineHeight="1.3"
          _hover={{ color: 'brand.500' }}
        >
          {product.name}
        </Text>
        <Text fontWeight="700" fontSize="xl" color="gray.800" _dark={{ color: 'white' }}>
          {formatPrice(product.price)}
        </Text>
        {product.description && (
          <Text fontSize="sm" color={muted} noOfLines={2}>
            {product.description}
          </Text>
        )}
        <Button
          mt="auto"
          colorScheme="brand"
          borderRadius="full"
          size="md"
          onClick={handleAdd}
          isDisabled={type === 'product' && product.stock === 0}
          w="fit-content"
          px={6}
        >
          {type === 'service' ? 'Contratar' : 'Comprar Ahora'}
        </Button>
      </VStack>
    </Box>
  );
}
