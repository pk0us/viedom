import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const email = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
export class LoginDto {
  @Transform(email) @IsEmail() @MaxLength(254) email!: string;
  @IsString() @Length(1, 128) password!: string;
}
export class RegisterDto {
  @Transform(email) @IsEmail() @MaxLength(254) email!: string;
  @IsString() @Length(12, 128) password!: string;
  @Transform(trimmed) @IsString() @Length(1, 100) firstName!: string;
  @Transform(trimmed) @IsString() @Length(1, 100) lastName!: string;
}
export class EmptyDto {}
