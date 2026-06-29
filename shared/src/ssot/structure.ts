import { TableStructure } from '../types/types';

type LocalizedText = {
  es: string;
  en: string;
};

function getCurrentLanguage(): keyof LocalizedText {
  return globalThis.localStorage?.getItem('language') === 'en' ? 'en' : 'es';
}

function localizeText(text: LocalizedText): string {
  return text[getCurrentLanguage()] ?? text.es;
}

const pkColumn = {
  type: 'string',
  label: { es: 'ID', en: 'ID' },
  editable: false,
  derivable: { originTable: '', sqlGenerationStatement: 'id' },
} as const;

export const structure = {
  tables: {
    clients: {
      columns: {
        id: pkColumn,
        business_id: {
          type: 'string',
          label: { es: 'Negocio', en: 'Business' },
          input: 'select',
          validator: { required: true },
          foreignKey: { table: 'businesses', valueField: 'id', labelField: 'name' },
        },

        user_id: {
          type: 'string',
          label: { es: 'Usuario', en: 'User' },
          input: 'select',
          validator: { required: true },
          foreignKey: { table: 'users', valueField: 'id', labelField: 'username' },
        },

        display_name: {
          type: 'string',
          label: { es: 'Nombre', en: 'Name' },
          validator: { required: true },
        },

        email: {
          type: 'string',
          label: { es: 'Email', en: 'Email' },
          input: 'email',
          validator: {
            nullable: true,
            pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
            patternMessage: 'must be a valid email address',
          },
        },

        phone: {
          type: 'string',
          label: { es: 'Teléfono', en: 'Phone' },
          validator: { nullable: true },
        },

        notes: {
          type: 'string',
          label: { es: 'Notas', en: 'Notes' },
          input: 'textarea',
          validator: { nullable: true },
        },
      },
      pk: 'id',
      uiName: { es: 'Cliente', en: 'Client' },
      title: { es: 'Clientes', en: 'Clients' },
      addButtonLabel: { es: 'Agregar Cliente', en: 'Add Client' },
    } satisfies TableStructure,

    professionals: {
      columns: {
        id: pkColumn,

        business_id: {
          type: 'string',
          label: { es: 'Negocio', en: 'Business' },
          input: 'select',
          validator: { required: true },
          foreignKey: { table: 'businesses', valueField: 'id', labelField: 'name' },
        },

        user_id: {
          type: 'string',
          label: { es: 'Usuario', en: 'User' },
          input: 'select',
          validator: { nullable: true },
          foreignKey: { table: 'users', valueField: 'id', labelField: 'username' },
        },

        display_name: {
          type: 'string',
          label: { es: 'Nombre', en: 'Name' },
          validator: { required: true },
        },

        bio: {
          type: 'string',
          label: { es: 'Biografía', en: 'Bio' },
          input: 'textarea',
          validator: { nullable: true },
        },
      },
      pk: 'id',
      uiName: { es: 'Profesional', en: 'Professional' },
      title: { es: 'Profesionales', en: 'Professionals' },
      addButtonLabel: { es: 'Agregar Profesional', en: 'Add Professional' },
    } satisfies TableStructure,

    resources: {
      columns: {
        id: pkColumn,

        business_id: {
          type: 'string',
          label: { es: 'Negocio', en: 'Business' },
          input: 'select',
          validator: { required: true },
          foreignKey: { table: 'businesses', valueField: 'id', labelField: 'name' },
        },

        name: {
          type: 'string',
          label: { es: 'Nombre', en: 'Name' },
          validator: { required: true },
        },

        description: {
          type: 'string',
          label: { es: 'Descripción', en: 'Description' },
          input: 'textarea',
          validator: { nullable: true },
        },
      },
      pk: 'id',
      uiName: { es: 'Recurso', en: 'Resource' },
      title: { es: 'Recursos', en: 'Resources' },
      addButtonLabel: { es: 'Agregar Recurso', en: 'Add Resource' },
    } satisfies TableStructure,

    services: {
      columns: {
        id: pkColumn,

        business_id: {
          type: 'string',
          label: { es: 'Negocio', en: 'Business' },
          input: 'select',
          validator: { required: true },
          foreignKey: { table: 'businesses', valueField: 'id', labelField: 'name' },
        },

        name: {
          type: 'string',
          label: { es: 'Nombre', en: 'Name' },
          validator: { required: true },
        },

        description: {
          type: 'string',
          label: { es: 'Descripción', en: 'Description' },
          input: 'textarea',
          validator: { nullable: true },
        },

        default_duration_minutes: {
          type: 'number',
          label: { es: 'Duración (min)', en: 'Duration (min)' },
          input: 'number',
          validator: { required: true, integer: true, minValue: 1 },
        },

        default_price_ars: {
          type: 'string',
          label: { es: 'Precio (ARS)', en: 'Price (ARS)' },
          validator: {
            required: true,
            pattern: '^\\d+(\\.\\d{1,2})?$',
            patternMessage: 'must be a non-negative amount',
          },
        },
      },
      pk: 'id',
      uiName: { es: 'Servicio', en: 'Service' },
      title: { es: 'Servicios', en: 'Services' },
      addButtonLabel: { es: 'Agregar Servicio', en: 'Add Service' },
    } satisfies TableStructure,

    client_professional_services: {
      columns: {
        id: pkColumn,

        client_id: {
          type: 'string',
          label: { es: 'Cliente', en: 'Client' },
          input: 'select',
          validator: { required: true },
          foreignKey: { table: 'clients', valueField: 'id', labelField: 'display_name' },
        },

        professional_id: {
          type: 'string',
          label: { es: 'Profesional', en: 'Professional' },
          input: 'select',
          validator: { required: true },
          foreignKey: { table: 'professionals', valueField: 'id', labelField: 'display_name' },
        },

        service_id: {
          type: 'string',
          label: { es: 'Servicio', en: 'Service' },
          input: 'select',
          validator: { required: true },
          foreignKey: { table: 'services', valueField: 'id', labelField: 'name' },
        },

        price_ars: {
          type: 'string',
          label: { es: 'Precio (ARS)', en: 'Price (ARS)' },
          validator: {
            required: true,
            pattern: '^\\d+(\\.\\d{1,2})?$',
            patternMessage: 'must be a non-negative amount',
          },
        },
      },
      pk: 'id',
      uiName: { es: 'Precio por Cliente', en: 'Client Price' },
      title: { es: 'Precios por Cliente', en: 'Client Prices' },
      addButtonLabel: { es: 'Agregar Precio', en: 'Add Price' },
    } satisfies TableStructure,

    schedules: {
      columns: {
        id: pkColumn,

        professional_id: {
          type: 'string',
          label: { es: 'Profesional', en: 'Professional' },
          input: 'select',
          validator: { nullable: true },
          foreignKey: { table: 'professionals', valueField: 'id', labelField: 'display_name' },
        },

        resource_id: {
          type: 'string',
          label: { es: 'Recurso', en: 'Resource' },
          input: 'select',
          validator: { nullable: true },
          foreignKey: { table: 'resources', valueField: 'id', labelField: 'name' },
        },

        weekly: {
          type: 'string',
          label: { es: 'Horario Semanal', en: 'Weekly Hours' },
          input: 'textarea',
          validator: { nullable: true },
        },
      },
      pk: 'id',
      uiName: { es: 'Horario', en: 'Schedule' },
      title: { es: 'Horarios', en: 'Schedules' },
      addButtonLabel: { es: 'Agregar Horario', en: 'Add Schedule' },
    } satisfies TableStructure,

    schedule_exceptions: {
      columns: {
        id: pkColumn,

        professional_id: {
          type: 'string',
          label: { es: 'Profesional', en: 'Professional' },
          input: 'select',
          validator: { nullable: true },
          foreignKey: { table: 'professionals', valueField: 'id', labelField: 'display_name' },
        },

        resource_id: {
          type: 'string',
          label: { es: 'Recurso', en: 'Resource' },
          input: 'select',
          validator: { nullable: true },
          foreignKey: { table: 'resources', valueField: 'id', labelField: 'name' },
        },

        exception_date: {
          type: 'string',
          label: { es: 'Fecha', en: 'Date' },
          input: 'date',
          validator: { required: true },
        },

        is_unavailable: {
          type: 'boolean',
          label: { es: 'No Disponible', en: 'Unavailable' },
          validator: { nullable: true },
        },

        start_time: {
          type: 'string',
          label: { es: 'Hora Inicio', en: 'Start Time' },
          validator: { nullable: true },
        },

        end_time: {
          type: 'string',
          label: { es: 'Hora Fin', en: 'End Time' },
          validator: { nullable: true },
        },

        reason: {
          type: 'string',
          label: { es: 'Motivo', en: 'Reason' },
          input: 'textarea',
          validator: { nullable: true },
        },
      },
      pk: 'id',
      uiName: { es: 'Excepción de Horario', en: 'Schedule Exception' },
      title: { es: 'Excepciones de Horario', en: 'Schedule Exceptions' },
      addButtonLabel: { es: 'Agregar Excepción', en: 'Add Exception' },
    } satisfies TableStructure,
  },

  menu: {
    theme: {
      title: { es: 'Tema', en: 'Theme' },
      id: 'theme-picker',
      handler: (value: string) => {
        try {
          if (!value) throw new Error('Theme value is required');

          document.body.setAttribute('data-theme', value);
          localStorage.setItem('theme', value);
        } catch (err) {
          console.error('Error changing theme:', err);
          alert(localizeText(structure.commonText.themeChangeError));
        }
      },
      options: [
        { value: 'light', label: { es: 'Claro', en: 'Light' } },
        { value: 'dark', label: { es: 'Oscuro', en: 'Dark' } },
      ],
      initial: () => localStorage.getItem('theme') || 'light',
    },

    language: {
      title: { es: 'Idioma', en: 'Language' },
      id: 'language-picker',
      handler: (value: string) => {
        try {
          if (value !== 'es' && value !== 'en') {
            throw new Error('Invalid language value');
          }

          localStorage.setItem('language', value);

          window.dispatchEvent(
            new CustomEvent('languagechange', {
              detail: { language: value },
            })
          );
        } catch (err) {
          console.error('Error changing language:', err);
          alert(localizeText(structure.commonText.languageChangeError));
        }
      },
      options: [
        { value: 'es', label: { es: 'Español', en: 'Spanish' } },
        { value: 'en', label: { es: 'Inglés', en: 'English' } },
      ],
      initial: () => localStorage.getItem('language') || 'es',
    },
  },

  commonText: {
    actions: { es: 'Acciones', en: 'Actions' },
    add: { es: 'Agregar', en: 'Add' },
    appTitle: {
      es: 'Agenda Profesional',
      en: 'Professional Scheduler',
    },
    cancel: { es: 'Cancelar', en: 'Cancel' },
    delete: { es: 'Eliminar', en: 'Delete' },
    edit: { es: 'Editar', en: 'Edit' },
    update: { es: 'Actualizar', en: 'Update' },
    login: { es: 'Ingresar', en: 'Login' },
    password: { es: 'Contraseña', en: 'Password' },
    changePassword: { es: 'Cambiar contraseña', en: 'Change Password' },
    currentPassword: { es: 'Contraseña actual', en: 'Current Password' },
    newPassword: { es: 'Nueva contraseña', en: 'New Password' },
    logout: { es: 'Salir', en: 'Logout' },
    addProfessional: { es: 'Agregar Profesional', en: 'Add Professional' },
    addAdmin: { es: 'Agregar Admin', en: 'Add Admin' },
    added: { es: 'agregado', en: 'added' },

    // Auth / session messages
    sessionExpired: { es: 'La sesión expiró', en: 'Session expired' },
    passwordChangeRequired: { es: 'Hay que cambiar la contraseña', en: 'Password change required' },
    noPermission: { es: 'No tenés permiso para esa acción', en: 'You do not have permission for that action' },
    invalidCredentials: { es: 'Credenciales inválidas', en: 'Invalid credentials' },
    loginError: { es: 'Error ingresando', en: 'Login error' },
    passwordChangeFailed: { es: 'No se pudo cambiar la contraseña', en: 'Password change failed' },
    passwordChangeError: { es: 'Error cambiando contraseña', en: 'Password change error' },
    themeChangeError: { es: 'Error al cambiar el tema', en: 'Error changing theme' },
    languageChangeError: { es: 'Error al cambiar el idioma', en: 'Error changing language' },

    // Data / record messages
    errorLoadingData: { es: 'Error cargando datos', en: 'Error loading data' },
    errorSaving: { es: 'Error guardando', en: 'Error saving' },
    errorDeleting: { es: 'Error eliminando', en: 'Error deleting' },
    errorLoadingRecord: { es: 'Error cargando registro', en: 'Error loading record' },

    // User management
    onlyAdminCanCreateUsers: { es: 'Solo admin puede crear usuarios', en: 'Only admin can create users' },
    errorCreatingUser: { es: 'Error creando usuario', en: 'Error creating user' },
    noEditPermission: { es: 'No tenés permiso para editar', en: 'You do not have edit permission' },
    userAdded: { es: 'Usuario agregado', en: 'User added' },

    // Form labels
    initialPassword: { es: 'Contraseña inicial', en: 'Initial Password' },
    usernameLabel: { es: 'Usuario', en: 'Username' },
    emailLabel: { es: 'Email', en: 'Email' },
    professionalRole: { es: 'Profesional', en: 'Professional' },
    receptionistRole: { es: 'Recepcionista', en: 'Receptionist' },
    clientRole: { es: 'Cliente', en: 'Client' },
    adminRole: { es: 'Admin', en: 'Admin' },
    addUser: { es: 'Agregar usuario', en: 'Add user' },

    // Filters / pagination
    addFilter: { es: 'Agregar Filtro', en: 'Add Filter' },
    selectColumn: { es: 'Seleccionar columna', en: 'Select column' },
    pageInfo: { es: 'Página', en: 'Page' },
    pageOf: { es: 'de', en: 'of' },
    total: { es: 'Total', en: 'Total' },
    previous: { es: 'Anterior', en: 'Previous' },
    next: { es: 'Siguiente', en: 'Next' },
    filterPlaceholder: { es: 'Filtrar...', en: 'Filter...' },

    // Delete confirmation
    deleteConfirm: {
      es: '¿Está seguro de que desea eliminar este',
      en: 'Are you sure you want to delete this',
    },
  } satisfies Record<string, LocalizedText>,
};
