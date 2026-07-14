import { SetMetadata } from '@nestjs/common';

/** Đánh dấu route BỎ QUA JwtAuthGuard (vd file proxy được load qua URL trực tiếp). */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
