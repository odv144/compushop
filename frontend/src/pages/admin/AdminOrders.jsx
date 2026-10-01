import { useEffect, useState } from 'react';
import {
  Box, Heading, Table, Thead, Tbody, Tr, Th, Td, Select, Badge, Spinner, Center, useColorModeValue, useToast, Text,
  Button, IconButton, HStack, VStack, Divider, SimpleGrid, useDisclosure, Modal, ModalOverlay, ModalContent, ModalHeader,
  ModalBody, ModalFooter, ModalCloseButton, Skeleton,
} from '@chakra-ui/react';
import { FiEye } from 'react-icons/fi';
import api from '../../api/client';
import { formatPrice } from '../../utils/format';

const formatDate = (d) => new Date(d).toLocaleString('es-AR');
const statuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];

const statusLabels = {
  pending: 'Pendiente', confirmed: 'Confirmado', processing: 'En proceso',
  shipped: 'Enviado', delivered: 'Entregado', cancelled: 'Cancelado',
};
const statusColors = {
  pending: 'yellow', confirmed: 'blue', processing: 'purple',
  shipped: 'cyan', delivered: 'green', cancelled: 'red',
};

const NO_INFO = 'No informó';
const informed = (v) => (v === null || v === undefined || String(v).trim() === '' ? NO_INFO : v);

export default function AdminOrders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const toast = useToast();
  const bg = useColorModeValue('white', 'gray.800');
  const subtle = useColorModeValue('gray.500', 'gray.400');
  const alertBg = useColorModeValue('red.50', 'whiteAlpha.100');

  const load = () => {
    setLoading(true);
    api.get('/orders?limit=50').then(r => setOrders(r.data.orders || [])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const fetchDetail = async (id) => {
    const r = await api.get(`/orders/${id}`);
    setDetail(r.data.order);
  };

  const closeDetail = () => {
    onClose();
    setSelectedId(null);
    setDetail(null);
  };

  const openDetail = async (id) => {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    onOpen();
    try {
      await fetchDetail(id);
    } catch (err) {
      toast({
        title: 'No se pudo cargar el detalle del pedido',
        description: err.response?.data?.error || 'Intentá de nuevo en unos segundos.',
        status: 'error',
      });
      closeDetail();
    } finally {
      setDetailLoading(false);
    }
  };

  const changeStatus = async (id, status) => {
    try {
      await api.put(`/orders/${id}/status`, { status });
      toast({ title: 'Estado actualizado', status: 'success' });
    } catch (err) {
      toast({
        title: 'No se pudo actualizar el estado',
        description: err.response?.data?.error || 'Intentá de nuevo en unos segundos.',
        status: 'error',
      });
    }
    // Recargamos siempre: si el PUT fallo, el <Select> controlado vuelve al valor real.
    await load();
    if (isOpen && selectedId === id) {
      try { await fetchDetail(id); } catch { /* la tabla ya esta al dia */ }
    }
  };

  const items = detail?.items || [];
  const subtotal = items.reduce((sum, it) => sum + Number(it.price) * Number(it.quantity), 0);
  const mismatch = detail && Math.abs(subtotal - Number(detail.total)) > 0.009;

  if (loading) return <Center py={10}><Spinner /></Center>;

  return (
    <Box>
      <Heading size="lg" mb={6}>Pedidos</Heading>
      <Box bg={bg} borderRadius="xl" borderWidth="1px" overflowX="auto">
        <Table size="sm">
          <Thead><Tr><Th>Nº</Th><Th>Cliente</Th><Th>Total</Th><Th>Estado</Th><Th>Fecha</Th><Th></Th></Tr></Thead>
          <Tbody>
            {orders.map(o => (
              <Tr key={o.id}>
                <Td fontFamily="mono">{o.order_number}</Td>
                <Td>
                  <Text>{o.customer_name}</Text>
                  <Text fontSize="xs" color="gray.500">{o.customer_email}</Text>
                </Td>
                <Td>{formatPrice(o.total)}</Td>
                <Td>
                  <Select size="sm" value={o.status} onChange={e => changeStatus(o.id, e.target.value)} maxW="140px">
                    {statuses.map(s => <option key={s} value={s}>{s}</option>)}
                  </Select>
                </Td>
                <Td>{formatDate(o.created_at)}</Td>
                <Td>
                  <IconButton
                    size="sm"
                    icon={<FiEye />}
                    variant="ghost"
                    colorScheme="brand"
                    onClick={() => openDetail(o.id)}
                    aria-label={`Ver detalle del pedido ${o.order_number}`}
                  />
                </Td>
              </Tr>
            ))}
            {orders.length === 0 && <Tr><Td colSpan={6}><Text textAlign="center" color="gray.500" py={4}>Sin pedidos</Text></Td></Tr>}
          </Tbody>
        </Table>
      </Box>

      <Modal isOpen={isOpen} onClose={closeDetail} size="3xl" scrollBehavior="inside">
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>
            {detail ? `Pedido ${detail.order_number}` : 'Detalle del pedido'}
          </ModalHeader>
          <ModalCloseButton />
          <ModalBody pb={6}>
            {detailLoading && (
              <VStack align="stretch" spacing={3}>
                <Skeleton h="20px" borderRadius="md" />
                <Skeleton h="20px" borderRadius="md" />
                <Skeleton h="120px" borderRadius="md" />
              </VStack>
            )}

            {!detailLoading && detail && (
              <>
                <HStack spacing={3} mb={5} flexWrap="wrap">
                  <Badge colorScheme={statusColors[detail.status] || 'gray'} fontSize="sm" px={2} py={1}>
                    {statusLabels[detail.status] || detail.status}
                  </Badge>
                  <Text fontSize="sm" color={subtle}>
                    Realizado el {formatDate(detail.created_at)}
                  </Text>
                </HStack>

                <Heading size="xs" mb={3}>Cliente y envío</Heading>
                <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} mb={6}>
                  <Box>
                    <Text fontSize="xs" color={subtle} textTransform="uppercase" fontWeight="bold">Cliente</Text>
                    <Text fontWeight="bold">{informed(detail.customer_name)}</Text>
                    <Text fontSize="sm" color={subtle}>{informed(detail.customer_email)}</Text>
                  </Box>
                  <Box>
                    <Text fontSize="xs" color={subtle} textTransform="uppercase" fontWeight="bold">Teléfono</Text>
                    <Text fontWeight="bold">{informed(detail.customer_phone)}</Text>
                  </Box>
                  <Box gridColumn={{ base: 'auto', md: '1 / -1' }}>
                    <Text fontSize="xs" color={subtle} textTransform="uppercase" fontWeight="bold">Dirección de envío</Text>
                    <Text fontWeight="bold" whiteSpace="pre-wrap">{informed(detail.shipping_address)}</Text>
                  </Box>
                  <Box gridColumn={{ base: 'auto', md: '1 / -1' }}>
                    <Text fontSize="xs" color={subtle} textTransform="uppercase" fontWeight="bold">Notas</Text>
                    <Text whiteSpace="pre-wrap">{informed(detail.notes)}</Text>
                  </Box>
                </SimpleGrid>

                <Heading size="xs" mb={3}>Items</Heading>
                <Box borderWidth="1px" borderRadius="lg" overflowX="auto">
                  <Table size="sm">
                    <Thead>
                      <Tr>
                        <Th>Producto</Th>
                        <Th>Tipo</Th>
                        <Th isNumeric>Cant.</Th>
                        <Th isNumeric>Precio unit.</Th>
                        <Th isNumeric>Subtotal</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {items.map(it => (
                        <Tr key={it.id}>
                          <Td>{it.name}</Td>
                          <Td>
                            <Badge colorScheme={it.type === 'service' ? 'purple' : 'blue'}>
                              {it.type === 'service' ? 'Servicio' : 'Producto'}
                            </Badge>
                          </Td>
                          <Td isNumeric>{it.quantity}</Td>
                          <Td isNumeric>{formatPrice(it.price)}</Td>
                          <Td isNumeric fontWeight="bold">{formatPrice(Number(it.price) * Number(it.quantity))}</Td>
                        </Tr>
                      ))}
                      {items.length === 0 && (
                        <Tr><Td colSpan={5}><Text textAlign="center" color={subtle} py={3}>Este pedido no tiene ítems</Text></Td></Tr>
                      )}
                    </Tbody>
                  </Table>
                </Box>

                <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={4} mt={5} textAlign="right">
                  <Box>
                    <Text fontSize="sm" color={subtle}>Subtotal items</Text>
                    <Text fontSize="lg">{formatPrice(subtotal)}</Text>
                  </Box>
                  <Box>
                    <Text fontSize="sm" color={subtle}>Total del pedido</Text>
                    <Text fontSize="2xl" fontWeight="bold" colorScheme="brand">{formatPrice(detail.total)}</Text>
                  </Box>
                </SimpleGrid>

                {mismatch && (
                  <Box mt={4} p={3} borderRadius="lg" borderWidth="1px" borderColor="red.300" bg={alertBg}>
                    <Text fontSize="sm" color="red.400" fontWeight="bold">
                      El total no coincide con la suma de los ítems. Revisá el pedido antes de cobrarlo.
                    </Text>
                  </Box>
                )}
              </>
            )}
          </ModalBody>
          <Divider />
          <ModalFooter>
            <Button variant="ghost" onClick={closeDetail}>Cerrar</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  );
}