import { useEffect, useState } from 'react';
import {
  Box, Heading, Button, Table, Thead, Tbody, Tr, Th, Td, IconButton, useToast, useDisclosure,
  Modal, ModalOverlay, ModalContent, ModalHeader, ModalBody, ModalFooter, FormControl, FormLabel,
  Input, Textarea, NumberInput, NumberInputField, Switch, HStack, Spinner, Center, useColorModeValue,
} from '@chakra-ui/react';
import { FiPlus, FiEdit, FiTrash2 } from 'react-icons/fi';
import api from '../../api/client';

const formatPrice = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);
const empty = { name: '', description: '', price: 0, duration: '', image: '', is_active: true };

export default function AdminServices() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(empty);
  const [editId, setEditId] = useState(null);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const toast = useToast();
  const bg = useColorModeValue('white', 'gray.800');

  const load = () => {
    setLoading(true);
    api.get('/services?active=all').then(r => setList(r.data.services || [])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditId(null); setForm(empty); onOpen(); };
  const openEdit = (s) => { setEditId(s.id); setForm({ name: s.name, description: s.description || '', price: s.price, duration: s.duration || '', image: s.image || '', is_active: s.is_active }); onOpen(); };

  const save = async () => {
    try {
      const payload = { ...form, price: Number(form.price) };
      if (editId) await api.put(`/services/${editId}`, payload);
      else await api.post('/services', payload);
      toast({ title: 'Guardado', status: 'success' });
      onClose(); load();
    } catch (err) {
      toast({ title: 'Error', description: err.response?.data?.error, status: 'error' });
    }
  };

  const remove = async (id) => {
    if (!confirm('¿Eliminar?')) return;
    await api.delete(`/services/${id}`);
    toast({ title: 'Eliminado', status: 'info' });
    load();
  };

  if (loading) return <Center py={10}><Spinner /></Center>;

  return (
    <Box>
      <HStack justify="space-between" mb={6}>
        <Heading size="lg">Servicios</Heading>
        <Button leftIcon={<FiPlus />} colorScheme="brand" onClick={openCreate}>Nuevo</Button>
      </HStack>
      <Box bg={bg} borderRadius="xl" borderWidth="1px" overflowX="auto">
        <Table size="sm">
          <Thead><Tr><Th>Nombre</Th><Th>Precio</Th><Th>Duración</Th><Th>Activo</Th><Th></Th></Tr></Thead>
          <Tbody>
            {list.map(s => (
              <Tr key={s.id}>
                <Td>{s.name}</Td>
                <Td>{formatPrice(s.price)}</Td>
                <Td>{s.duration}</Td>
                <Td>{s.is_active ? 'Sí' : 'No'}</Td>
                <Td>
                  <HStack>
                    <IconButton size="sm" icon={<FiEdit />} onClick={() => openEdit(s)} aria-label="Editar" />
                    <IconButton size="sm" icon={<FiTrash2 />} colorScheme="red" variant="ghost" onClick={() => remove(s.id)} aria-label="Eliminar" />
                  </HStack>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>
      <Modal isOpen={isOpen} onClose={onClose} size="lg">
        <ModalOverlay /><ModalContent>
          <ModalHeader>{editId ? 'Editar' : 'Nuevo'} servicio</ModalHeader>
          <ModalBody>
            <FormControl mb={3} isRequired><FormLabel>Nombre</FormLabel><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></FormControl>
            <FormControl mb={3}><FormLabel>Descripción</FormLabel><Textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></FormControl>
            <FormControl mb={3} isRequired><FormLabel>Precio</FormLabel><NumberInput value={form.price} onChange={v => setForm({ ...form, price: v })}><NumberInputField /></NumberInput></FormControl>
            <FormControl mb={3}><FormLabel>Duración</FormLabel><Input value={form.duration} onChange={e => setForm({ ...form, duration: e.target.value })} /></FormControl>
            <FormControl mb={3}><FormLabel>URL imagen</FormLabel><Input value={form.image} onChange={e => setForm({ ...form, image: e.target.value })} /></FormControl>
            <FormControl display="flex" alignItems="center"><FormLabel mb={0}>Activo</FormLabel><Switch isChecked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} /></FormControl>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={onClose}>Cancelar</Button>
            <Button colorScheme="brand" onClick={save}>Guardar</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  );
}
