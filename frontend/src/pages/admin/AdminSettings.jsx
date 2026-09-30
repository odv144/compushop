import { useEffect, useState } from 'react';
import {
  Box, Heading, VStack, FormControl, FormLabel, Input, Button, useToast, useColorModeValue, Text, SimpleGrid,
} from '@chakra-ui/react';
import api from '../../api/client';

export default function AdminSettings() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const bg = useColorModeValue('white', 'gray.800');

  useEffect(() => {
    api.get('/settings').then(r => setSettings(r.data.settings || {})).catch(console.error);
  }, []);

  const save = async () => {
    setLoading(true);
    try {
      await api.put('/settings', settings);
      toast({ title: 'Configuración guardada', status: 'success' });
    } catch (err) {
      toast({ title: 'Error', status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const set = (k, v) => setSettings(s => ({ ...s, [k]: v }));

  return (
    <Box>
      <Heading size="lg" mb={2}>Configuración</Heading>
      <Text color="gray.500" mb={6}>Datos de la tienda y SMTP para emails de contacto / recuperación.</Text>

      <Box bg={bg} p={6} borderRadius="xl" borderWidth="1px" mb={6}>
        <Heading size="sm" mb={4}>Datos de la tienda</Heading>
        <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4}>
          <FormControl><FormLabel>Nombre</FormLabel><Input value={settings.store_name || ''} onChange={e => set('store_name', e.target.value)} /></FormControl>
          <FormControl><FormLabel>Email</FormLabel><Input value={settings.store_email || ''} onChange={e => set('store_email', e.target.value)} /></FormControl>
          <FormControl><FormLabel>Teléfono</FormLabel><Input value={settings.store_phone || ''} onChange={e => set('store_phone', e.target.value)} /></FormControl>
          <FormControl><FormLabel>Dirección</FormLabel><Input value={settings.store_address || ''} onChange={e => set('store_address', e.target.value)} /></FormControl>
        </SimpleGrid>
      </Box>

      <Box bg={bg} p={6} borderRadius="xl" borderWidth="1px" mb={6}>
        <Heading size="sm" mb={4}>SMTP (envío de emails)</Heading>
        <Text fontSize="sm" color="gray.500" mb={4}>Para Gmail usá una “Contraseña de aplicación”.</Text>
        <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4}>
          <FormControl><FormLabel>Host</FormLabel><Input value={settings.smtp_host || ''} onChange={e => set('smtp_host', e.target.value)} placeholder="smtp.gmail.com" /></FormControl>
          <FormControl><FormLabel>Puerto</FormLabel><Input value={settings.smtp_port || ''} onChange={e => set('smtp_port', e.target.value)} placeholder="587" /></FormControl>
          <FormControl><FormLabel>Usuario</FormLabel><Input value={settings.smtp_user || ''} onChange={e => set('smtp_user', e.target.value)} /></FormControl>
          <FormControl><FormLabel>Contraseña</FormLabel><Input type="password" value={settings.smtp_pass || ''} onChange={e => set('smtp_pass', e.target.value)} /></FormControl>
          <FormControl><FormLabel>From</FormLabel><Input value={settings.smtp_from || ''} onChange={e => set('smtp_from', e.target.value)} /></FormControl>
          <FormControl><FormLabel>Email destino contacto</FormLabel><Input value={settings.contact_to || ''} onChange={e => set('contact_to', e.target.value)} /></FormControl>
        </SimpleGrid>
      </Box>

      <Button colorScheme="brand" onClick={save} isLoading={loading}>Guardar configuración</Button>
    </Box>
  );
}
