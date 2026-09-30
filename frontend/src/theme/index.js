import { extendTheme } from '@chakra-ui/react';

const config = {
  initialColorMode: 'light',
  useSystemColorMode: false,
};

// Paleta original del proyecto Compushop (azul corporativo)
const colors = {
  brand: {
    50: '#e6f0ff',
    100: '#b3d1ff',
    200: '#80b3ff',
    300: '#4d94ff',
    400: '#1a75ff',
    500: '#0066e6',
    600: '#0052b3',
    700: '#003d80',
    800: '#00294d',
    900: '#00141a',
  },
  surface: {
    light: '#f4f7fb',
    card: '#ffffff',
    muted: '#eef2f7',
  },
};

const fonts = {
  heading: `'Inter', system-ui, -apple-system, sans-serif`,
  body: `'Inter', system-ui, -apple-system, sans-serif`,
};

const radii = {
  none: '0',
  sm: '0.375rem',
  md: '0.75rem',
  lg: '1.25rem',
  xl: '1.75rem',
  '2xl': '2rem',
  '3xl': '2.5rem',
  full: '9999px',
};

const styles = {
  global: (props) => ({
    body: {
      bg: props.colorMode === 'dark' ? 'gray.900' : 'surface.light',
      color: props.colorMode === 'dark' ? 'gray.100' : 'gray.800',
    },
  }),
};

const components = {
  Button: {
    defaultProps: { colorScheme: 'brand' },
    baseStyle: {
      fontWeight: '600',
      borderRadius: 'full',
    },
    variants: {
      solid: (props) => ({
        bg: `${props.colorScheme}.500`,
        color: 'white',
        _hover: {
          bg: `${props.colorScheme}.600`,
          transform: 'translateY(-1px)',
          shadow: 'md',
          _disabled: { bg: `${props.colorScheme}.500` },
        },
        _active: { bg: `${props.colorScheme}.700` },
      }),
      // Outline normal (formularios, modo claro/oscuro)
      outline: (props) => ({
        borderWidth: '2px',
        borderColor: `${props.colorScheme}.500`,
        color: `${props.colorScheme}.500`,
        bg: 'transparent',
        _hover: {
          bg: props.colorMode === 'dark' ? 'whiteAlpha.100' : `${props.colorScheme}.50`,
        },
      }),
      // Outline sobre fondos oscuros (hero)
      outlineLight: {
        borderWidth: '2px',
        borderColor: 'white',
        color: 'white',
        bg: 'transparent',
        _hover: { bg: 'whiteAlpha.200' },
      },
      ghost: {
        _hover: { bg: 'blackAlpha.50' },
        _dark: { _hover: { bg: 'whiteAlpha.100' } },
      },
    },
  },
  Input: {
    defaultProps: { focusBorderColor: 'brand.500' },
    variants: {
      outline: (props) => ({
        field: {
          borderRadius: 'lg',
          bg: props.colorMode === 'dark' ? 'gray.700' : 'white',
          borderColor: props.colorMode === 'dark' ? 'gray.600' : 'gray.200',
          _hover: {
            borderColor: props.colorMode === 'dark' ? 'gray.500' : 'gray.300',
          },
          _focus: {
            borderColor: 'brand.500',
            boxShadow: '0 0 0 1px var(--chakra-colors-brand-500)',
          },
        },
      }),
    },
  },
  FormLabel: {
    baseStyle: (props) => ({
      color: props.colorMode === 'dark' ? 'gray.200' : 'gray.700',
      fontWeight: '600',
      fontSize: 'sm',
    }),
  },
  Link: {
    baseStyle: { _hover: { textDecoration: 'none' } },
  },
};

export default extendTheme({ config, colors, fonts, radii, styles, components });
