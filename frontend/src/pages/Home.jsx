import { useEffect, useState } from 'react';
import {
  Box, Container, Heading, Text, SimpleGrid, Button, VStack, HStack,
  useColorModeValue, Spinner, Center, Image, Flex, Stat, StatNumber, StatLabel,
} from '@chakra-ui/react';
import { Link as RouterLink } from 'react-router-dom';
import api from '../api/client';
import ProductCard from '../components/ProductCard';

export default function Home() {
  const [products, setProducts] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const sectionBg = useColorModeValue('white', 'gray.800');
  const mutedBg = useColorModeValue('surface.light', 'gray.900');
  const muted = useColorModeValue('gray.600', 'gray.400');

  useEffect(() => {
    Promise.all([
      api.get('/products?limit=6'),
      api.get('/services'),
    ])
      .then(([p, s]) => {
        setProducts(p.data.products || []);
        setServices((s.data.services || []).slice(0, 4));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <Box mt={{ base: -20, md: -24 }}>
      {/* ===== HERO (estilo plantilla: full bleed + tipografía grande) ===== */}
      <Box
        position="relative"
        minH={{ base: '85vh', md: '92vh' }}
        display="flex"
        alignItems="center"
        justifyContent="center"
        bgImage="url('https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1600&q=80')"
        bgSize="cover"
        bgPosition="center"
        _before={{
          content: '""',
          position: 'absolute',
          inset: 0,
          bg: 'blackAlpha.650',
        }}
      >
        <Container maxW="4xl" position="relative" zIndex={1} textAlign="center" px={6}>
          <Heading
            as="h1"
            fontSize={{ base: '3.5rem', md: '5rem', lg: '5.5rem' }}
            fontWeight="800"
            color="white"
            lineHeight="1.05"
            letterSpacing="-0.02em"
            mb={4}
          >
            Tecnología Nítida
          </Heading>
          <Text
            fontSize={{ base: 'md', md: 'xl' }}
            color="whiteAlpha.900"
            maxW="lg"
            mx="auto"
            mb={8}
          >
            Excelencia en computadoras, insumos de oficina y servicio técnico especializado.
          </Text>
          <HStack justify="center" spacing={4} flexWrap="wrap">
            <Button
              as={RouterLink}
              to="/productos"
              size="lg"
              colorScheme="brand"
              borderRadius="full"
              px={8}
            >
              Ver productos
            </Button>
            <Button
              as={RouterLink}
              to="/servicios"
              size="lg"
              variant="outlineLight"
              borderRadius="full"
              px={8}
              borderColor="white"
              color="white"
              _hover={{ bg: 'whiteAlpha.200' }}
            >
              Ver Más
            </Button>
          </HStack>
        </Container>
      </Box>

      {/* ===== SOBRE NOSOTROS ===== */}
      <Box bg={sectionBg} py={{ base: 16, md: 24 }}>
        <Container maxW="6xl">
          <Flex direction={{ base: 'column', md: 'row' }} gap={12} align="center">
            <Box flex="1" borderRadius="3xl" overflow="hidden" shadow="xl">
              <Image
                src="https://images.unsplash.com/photo-1498050108023-c8199c13a8c5?w=800"
                alt="Espacio de trabajo"
                w="100%"
                h={{ base: '260px', md: '380px' }}
                objectFit="cover"
              />
            </Box>
            <VStack align={{ base: 'center', md: 'start' }} spacing={5} flex="1" textAlign={{ base: 'center', md: 'left' }}>
              <Heading size="xl" fontWeight="800">
                Nuestra pasión por la tecnología
              </Heading>
              <Text color={muted} fontSize="lg" lineHeight="1.8">
                En Compushop ofrecemos soluciones de calidad en notebooks, PCs, componentes,
                muebles de oficina e insumos. Nuestro equipo técnico está capacitado para
                resolver cualquier necesidad de tu equipo o tu empresa.
              </Text>
              <Text color={muted} lineHeight="1.8">
                Creemos en la honestidad y el compromiso: cada producto y servicio refleja
                nuestra dedicación a tu satisfacción.
              </Text>
              <Button as={RouterLink} to="/contacto" colorScheme="brand" borderRadius="full" size="lg" px={8}>
                Contáctanos
              </Button>
            </VStack>
          </Flex>
        </Container>
      </Box>

      {/* ===== CATÁLOGO ===== */}
      <Box bg={mutedBg} py={{ base: 16, md: 20 }}>
        <Container maxW="7xl">
          <VStack spacing={3} mb={10} textAlign="center">
            <Heading size="xl" fontWeight="800">Catálogo de productos</Heading>
            <Text color={muted} maxW="md">
              Equipamiento seleccionado para profesionales, gamers y oficinas.
            </Text>
          </VStack>
          {loading ? (
            <Center py={10}><Spinner size="xl" color="brand.500" /></Center>
          ) : (
            <SimpleGrid columns={{ base: 1, sm: 2, lg: 3 }} spacing={8}>
              {products.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </SimpleGrid>
          )}
          <Center mt={10}>
            <Button as={RouterLink} to="/productos" variant="outline" colorScheme="brand" borderRadius="full" size="lg" px={8}>
              Ver todo el catálogo
            </Button>
          </Center>
        </Container>
      </Box>

      {/* ===== BANNER DESCUENTO ===== */}
      <Box
        bg="brand.500"
        py={{ base: 12, md: 16 }}
        bgImage="linear-gradient(135deg, #0066e6 0%, #0052b3 100%)"
      >
        <Container maxW="4xl" textAlign="center">
          <Heading size="lg" color="white" mb={4} fontWeight="800">
            ¡Aprovechá un 15% de descuento en tu primera compra!
          </Heading>
          <Text color="whiteAlpha.900" mb={6}>
            Registrate y obtené beneficios exclusivos en productos y servicios técnicos.
          </Text>
          <Button
            as={RouterLink}
            to="/registro"
            bg="white"
            color="brand.600"
            borderRadius="full"
            size="lg"
            px={8}
            _hover={{ bg: 'gray.100' }}
          >
            Comprar Ahora
          </Button>
        </Container>
      </Box>

      {/* ===== SERVICIOS ===== */}
      <Box bg={sectionBg} py={{ base: 16, md: 20 }}>
        <Container maxW="7xl">
          <VStack spacing={3} mb={10} textAlign="center">
            <Heading size="xl" fontWeight="800">Servicios técnicos</Heading>
            <Text color={muted}>Armado, reparación, mantenimiento y más.</Text>
          </VStack>
          <SimpleGrid columns={{ base: 1, sm: 2, lg: 4 }} spacing={6}>
            {services.map((s) => (
              <ProductCard key={s.id} product={s} type="service" />
            ))}
          </SimpleGrid>
        </Container>
      </Box>

      {/* ===== STATS ===== */}
      <Box bg={mutedBg} py={{ base: 12, md: 16 }}>
        <Container maxW="5xl">
          <SimpleGrid columns={{ base: 1, md: 3 }} spacing={8} textAlign="center">
            {[
              { n: '1.500+', l: 'Clientes satisfechos' },
              { n: '300+', l: 'Productos disponibles' },
              { n: '10+', l: 'Años de experiencia' },
            ].map((s) => (
              <Box key={s.l}>
                <Stat>
                  <StatNumber fontSize="4xl" fontWeight="800" color="brand.500">{s.n}</StatNumber>
                  <StatLabel fontSize="md" color={muted}>{s.l}</StatLabel>
                </Stat>
              </Box>
            ))}
          </SimpleGrid>
        </Container>
      </Box>

      {/* ===== CTA FINAL ===== */}
      <Box py={{ base: 16, md: 20 }}>
        <Container maxW="4xl">
          <Box
            bg={useColorModeValue('gray.900', 'gray.800')}
            borderRadius="3xl"
            p={{ base: 8, md: 12 }}
            textAlign="center"
            color="white"
          >
            <Heading size="lg" mb={4} fontWeight="800">¿Necesitás asesoramiento?</Heading>
            <Text mb={6} opacity={0.85} maxW="md" mx="auto">
              Contactanos y te ayudamos a armar la solución ideal para vos o tu empresa.
            </Text>
            <Button as={RouterLink} to="/contacto" colorScheme="brand" size="lg" borderRadius="full" px={8}>
              Contáctanos Ahora
            </Button>
          </Box>
        </Container>
      </Box>
    </Box>
  );
}
