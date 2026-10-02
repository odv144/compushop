import { useEffect, useState } from 'react';
import {
  Box, Heading, Button, Table, Thead, Tbody, Tr, Th, Td, IconButton, useToast, useDisclosure,
  Modal, ModalOverlay, ModalContent, ModalHeader, ModalBody, ModalFooter, FormControl, FormLabel,
  Input, Textarea, NumberInput, NumberInputField, Select, Switch, HStack, Spinner, Center, useColorModeValue, Badge,
} from '@chakra-ui/react';
import { FiPlus, FiEdit, FiTrash2 } from 'react-icons/fi';
import api from '../../api/client';
import { formatPrice } from '../../utils/format';

const empty = { name: '', description: '', price: '', stock: 0, category_id: '', brand: '', image: '', is_active: true };

export default function AdminProducts() {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(empty);
  const [editId, setEditId] = useState(null);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const toast = useToast();
  const bg = useColorModeValue('white', 'gray.800');

  const load = () => {
    setLoading(true);
    Promise.all([
      api.get('/products?active=all&limit=100'),
      api.get('/categories'),
    ]).then(([p, c]) => {
      setProducts(p.data.products || []);
      setCategories(c.data.categories || []);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditId(null); setForm(empty); onOpen(); };
  const openEdit = (p) => {
    setEditId(p.id);
    setForm({ name: p.name, description: p.description || '', price: p.price, stock: p.stock, category_id: p.category_id || '', brand: p.brand || '', image: p.image || '', is_active: p.is_active });
    onOpen();
  };

  const save = async () => {
    // Number('') === 0: sin esta guarda, borrar el campo guardaba el producto
    // en $0 con un toast verde. isRequired de Chakra es solo visual y el boton
    // es onClick, no submit: nada impedia seguir adelante.
    const precio = Number(form.price);
    const vacio = form.price === '' || form.price === null || form.price === undefined;
    if (vacio || !Number.isFinite(precio) || precio < 0) {
      toast({ title: 'Revisá el precio', description: 'Ingresá un número mayor o igual a 0.', status: 'error' });
      return;
    }
    try {
      const payload = { ...form, price: precio, stock: Number(form.stock), category_id: form.category_id ? Number(form.category_id) : null };
      if (editId) await api.put(`/products/${editId}`, payload);
      else await api.post('/products', payload);
      toast({ title: editId ? 'Actualizado' : 'Creado', status: 'success' });
      onClose();
      load();
    } catch (err) {
      toast({ title: 'Error', description: err.response?.data?.error, status: 'error' });
    }
  };

  const remove = async (id) => {
    if (!confirm('¿Eliminar producto?')) return;
    await api.delete(`/products/${id}`);
    toast({ title: 'Eliminado', status: 'info' });
    load();
  };

  if (loading) return <Center py={10}><Spinner /></Center>;

  return (
    <Box>
      <HStack justify="space-between" mb={6}>
        <Heading size="lg">Productos</Heading>
        <Button leftIcon={<FiPlus />} colorScheme="brand" onClick={openCreate}>Nuevo</Button>
      </HStack>
      <Box bg={bg} borderRadius="xl" borderWidth="1px" overflowX="auto">
        <Table size="sm">
          <Thead><Tr><Th>Nombre</Th><Th>Precio</Th><Th>Stock</Th><Th>Activo</Th><Th></Th></Tr></Thead>
          <Tbody>
            {products.map(p => (
              <Tr key={p.id}>
                <Td>{p.name}</Td>
                <Td>{formatPrice(p.price)}</Td>
                <Td><Badge colorScheme={p.stock <= 5 ? 'orange' : 'green'}>{p.stock}</Badge></Td>
                <Td>{p.is_active ? 'Sí' : 'No'}</Td>
                <Td>
                  <HStack>
                    <IconButton size="sm" icon={<FiEdit />} onClick={() => openEdit(p)} aria-label="Editar" />
                    <IconButton size="sm" icon={<FiTrash2 />} colorScheme="red" variant="ghost" onClick={() => remove(p.id)} aria-label="Eliminar" />
                  </HStack>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>

      <Modal isOpen={isOpen} onClose={onClose} size="xl">
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{editId ? 'Editar producto' : 'Nuevo producto'}</ModalHeader>
          <ModalBody>
            <FormControl mb={3} isRequired><FormLabel>Nombre</FormLabel><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></FormControl>
            <FormControl mb={3}><FormLabel>Descripción</FormLabel><Textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></FormControl>
            <HStack mb={3}>
              <FormControl isRequired><FormLabel>Precio</FormLabel>
                <NumberInput
                  value={form.price}
                  onChange={(v, num) => setForm({ ...form, price: num === undefined || Number.isNaN(num) ? v : num })}
                  precision={2}
                  step={0.01}
                  min={0}
                  pattern="[0-9]*([.,][0-9]+)?"
                  // Chakra borra la coma: sanitize() filtra por /^[Ee0-9+\-.]$/ y
                  // onKeyDown la bloquea antes de escribirla. Sin estas dos piezas,
                  // un admin que escribe 6899,99 guardaba 689999 (precio x100).
                  isValidCharacter={(c) => /[0-9.,-]/.test(c)}
                  parse={(v) => String(v).replace(',', '.')}
                >
                  <NumberInputField placeholder="0,00" />
                </NumberInput>
              </FormControl>
              <FormControl><FormLabel>Stock</FormLabel><NumberInput value={form.stock} onChange={v => setForm({ ...form, stock: v })}><NumberInputField /></NumberInput></FormControl>
            </HStack>
            <FormControl mb={3}><FormLabel>Categoría</FormLabel>
              <Select placeholder="Seleccionar" value={form.category_id} onChange={e => setForm({ ...form, category_id: e.target.value })}>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </FormControl>
            <FormControl mb={3}><FormLabel>Marca</FormLabel><Input value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} /></FormControl>
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
