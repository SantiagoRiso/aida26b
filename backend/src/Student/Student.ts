import { Pool } from 'pg';
import { StudentStatus } from './StudentStatus';
import {ValidationError} from '../Error/ValidationError';

export class Student {
    nro_libreta: string;
    dni: string;
    first_name: string;
    last_name: string;
    email: string;
    enrollment_date: Date | string;
    status: StudentStatus | string;

    constructor(data: { nro_libreta: string; dni: string; first_name: string; last_name: string; email: string; enrollment_date: Date; status: StudentStatus }) {
        this.nro_libreta = data.nro_libreta;
        this.dni = data.dni;
        this.first_name = data.first_name;
        this.last_name = data.last_name;
        this.email = data.email;
        this.enrollment_date = data.enrollment_date;
        this.status = data.status;
    }

    static async createStudent(pool: Pool, student: Student): Promise<Student> {

        student.validateStudent();
        
        const result = await pool.query(
            'INSERT INTO students (numero_libreta, dni, first_name, last_name, email, enrollment_date, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [student.nro_libreta, student.dni, student.first_name, student.last_name, student.email, student.enrollment_date, student.status]
        );
        const row = result.rows[0];
        return new Student({
            nro_libreta: row.numero_libreta,
            dni: row.dni,
            first_name: row.first_name,
            last_name: row.last_name,
            email: row.email,
            enrollment_date: new Date(row.enrollment_date),
            status: row.status as StudentStatus,
        });
    }

    validateStudent() : void {
        if (!validateNroLibreta(this.nro_libreta)) throw new ValidationError('Invalid nro_libreta');
        if (!validateDni(this.dni)) throw new ValidationError('Invalid dni');
        if (!validateName(this.first_name)) throw new ValidationError('Invalid first_name');
        if (!validateName(this.last_name)) throw new ValidationError('Invalid last_name');
        if (!validateEmail(this.email)) throw new ValidationError('Invalid email');
        if (!validateEnrollmentDate(this.enrollment_date)) throw new ValidationError('Invalid enrollment_date');
        if (!validateStatus(this.status)) throw new ValidationError('Invalid status');
    }
}

function validateNroLibreta(nro_libreta: string): boolean {
    return nro_libreta != null && /^\d{3,4}\/\d{2}$/.test(nro_libreta.trim());
}

function validateDni(dni: string): boolean {
    return dni != null && /^\d{7,8}$/.test(dni.trim());
}

function validateName(name: string): boolean {
    return name != null && name.trim().length > 1;
}

function validateEmail(email: string): boolean {
    return email != null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function validateEnrollmentDate(enrollmanteDate: Date | string): boolean {
    if (typeof enrollmanteDate === 'string') enrollmanteDate = new Date(enrollmanteDate);
    return enrollmanteDate instanceof Date && !isNaN(enrollmanteDate.getTime()) && Date.now() >= enrollmanteDate.getTime();
}

function validateStatus(status: StudentStatus | string): boolean {
    return status != null && Object.values(StudentStatus).includes(status as StudentStatus);
}