import { Injectable } from '@nestjs/common';
import { loadConfig } from '../../../scripts/config.mjs';

@Injectable()
export class Configuration {
  readonly values = loadConfig();
}
