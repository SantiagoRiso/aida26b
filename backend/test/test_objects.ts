export function clientFor(_userId: string) {
  return {
    display_name: 'Homero Simpson',
    phone: '1144440000',
    dni: '20111111',
    notes: 'VIP',
  };
}

export function clientModifiedFor(_userId: string) {
  return {
    display_name: 'Homero J. Simpson',
    phone: '1155550000',
    dni: '20222222',
    notes: 'Regular',
  };
}

export function professionalFor(_userId: string) {
  return {
    display_name: 'Marge Bouvier',
    bio: 'Senior stylist',
  };
}

export function professionalModifiedFor(_userId: string) {
  return {
    display_name: 'Marge Simpson',
    bio: 'Lead stylist',
  };
}

export function serviceFor(_businessId?: string) {
  return {
    name: 'Haircut',
    description: 'Standard haircut',
    default_duration_minutes: 30,
    default_price_ars: '1500.00',
  };
}

export function serviceModifiedFor(_businessId?: string) {
  return {
    name: 'Haircut & Style',
    description: 'Cut and blow-dry',
    default_duration_minutes: 45,
    default_price_ars: '2500.00',
  };
}

export function clientPriceFor(clientUserId: string, professionalUserId: string, serviceId: string) {
  return {
    client_user_id: clientUserId,
    professional_user_id: professionalUserId,
    service_id: serviceId,
    price_ars: '1200.00',
  };
}
