import { useEffect, useState } from 'react';
import { Container, Heading, SimpleGrid, Spinner, Center, Text } from '@chakra-ui/react';
import api from '../api/client';
import ProductCard from '../components/ProductCard';

export default function Services() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/services').then(r => setServices(r.data.services || []))
      .catch(console.error).finally(() => setLoading(false));
  }, []);

  return (
    <Container maxW="7xl" py={10}>
      <Heading mb={2}>Servicios técnicos</Heading>
      <Text color="gray.500" mb={8}>Armado, reparación, mantenimiento y más.</Text>
      {loading ? (
        <Center py={20}><Spinner size="xl" color="brand.500" /></Center>
      ) : (
        <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4 }} spacing={6}>
          {services.map(s => <ProductCard key={s.id} product={s} type="service" />)}
        </SimpleGrid>
      )}
    </Container>
  );
}
