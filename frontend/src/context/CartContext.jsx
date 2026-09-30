import { createContext, useContext, useState, useEffect } from 'react';

const CartContext = createContext(null);

export function CartProvider({ children }) {
  const [items, setItems] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('compushop_cart') || '[]');
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem('compushop_cart', JSON.stringify(items));
  }, [items]);

  const addItem = (product, quantity = 1, type = 'product') => {
    setItems(prev => {
      const existing = prev.find(i => i.id === product.id && i.type === type);
      if (existing) {
        return prev.map(i =>
          i.id === product.id && i.type === type
            ? { ...i, quantity: i.quantity + quantity }
            : i
        );
      }
      return [...prev, {
        id: product.id,
        name: product.name,
        price: product.price,
        image: product.image,
        quantity,
        type,
      }];
    });
  };

  const removeItem = (id, type) => {
    setItems(prev => prev.filter(i => !(i.id === id && i.type === type)));
  };

  const updateQuantity = (id, type, quantity) => {
    if (quantity < 1) return removeItem(id, type);
    setItems(prev => prev.map(i =>
      i.id === id && i.type === type ? { ...i, quantity } : i
    ));
  };

  const clearCart = () => setItems([]);

  const totalItems = items.reduce((s, i) => s + i.quantity, 0);
  const totalPrice = items.reduce((s, i) => s + i.price * i.quantity, 0);

  return (
    <CartContext.Provider value={{ items, addItem, removeItem, updateQuantity, clearCart, totalItems, totalPrice }}>
      {children}
    </CartContext.Provider>
  );
}

export const useCart = () => useContext(CartContext);
