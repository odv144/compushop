import { useEffect, useState } from 'react';
import {
  Box, Container, Heading, SimpleGrid, Select, Input, HStack, Spinner, Center, Text, useColorModeValue,
} from '@chakra-ui/react';
import { useSearchParams } from 'react-router-dom';
import api from '../api/client';
import ProductCard from '../components/ProductCard';

export default function Products() {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [params, setParams] = useSearchParams();
  const category = params.get('category') || '';
  const search = params.get('search') || '';

  useEffect(() => {
    api.get('/categories').then(r => setCategories(r.data.categories || [])).catch(console.error);
  }, []);

  useEffect(() => {
    setLoading(true);
    const q = new URLSearchParams();
    if (category) q.set('category', category);
    if (search) q.set('search', search);
    q.set('limit', '50');
    api.get(`/products?${q}`).then(r => setProducts(r.data.products || []))
      .catch(console.error).finally(() => setLoading(false));
  }, [category, search]);

  return (
    <Container maxW="7xl" py={10}>
      <Heading mb={6}>Productos</Heading>
      <HStack mb={8} spacing={4} flexWrap="wrap">
        <Select
          maxW="240px"
          placeholder="Todas las categorías"
          value={category}
          onChange={e => {
            const p = new URLSearchParams(params);
            if (e.target.value) p.set('category', e.target.value); else p.delete('category');
            setParams(p);
          }}
          bg={useColorModeValue('white', 'gray.800')}
        >
          {categories.map(c => <option key={c.id} value={c.slug}>{c.name}</option>)}
        </Select>
        <Input
          maxW="320px"
          placeholder="Buscar productos..."
          defaultValue={search}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const p = new URLSearchParams(params);
              if (e.target.value) p.set('search', e.target.value); else p.delete('search');
              setParams(p);
            }
          }}
          bg={useColorModeValue('white', 'gray.800')}
        />
      </HStack>
      {loading ? (
        <Center py={20}><Spinner size="xl" color="brand.500" /></Center>
      ) : products.length === 0 ? (
        <Text color="gray.500" textAlign="center" py={10}>No se encontraron productos.</Text>
      ) : (
        <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4 }} spacing={6}>
          {products.map(p => <ProductCard key={p.id} product={p} />)}
        </SimpleGrid>
      )}
    </Container>
  );
}
