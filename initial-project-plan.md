# Real Estate Marketplace — Project Plan

**Project Type:** Public real-estate marketplace  
**Platform:** Web application  
**Architecture:** pnpm monorepo, Angular frontend, NestJS backend  
**Database:** MongoDB with MikroORM  
**Status:** Planning / MVP

---

## 1. Project Overview

Build a modern, map-first real-estate marketplace where people can publish properties for sale or rent and visitors can discover them through an interactive map.

The application will initially focus on the Greek real-estate market, starting with one city, but the architecture must support expansion into other cities and countries.

The platform should support individual property owners and, in later phases, real-estate agencies.

### Core Product Features

- Interactive map with property price markers
- Property searching and filtering
- Properties for sale and long-term rent
- Public property detail pages
- Multiple photographs per property
- Owner registration and authentication
- Property and listing management
- Contact forms for interested buyers or renters
- Administrative listing moderation
- Responsive design for desktop, tablet, and mobile

### Future Features

- User favorites
- Saved searches and email notifications
- Real-estate agency accounts
- Featured and promoted listings
- Property analytics and price history
- 360° panoramic property tours
- Interactive 3D property tours
- Paid subscriptions and promotional features

**Important:** The MVP must not include 360° or 3D tours. However, the application architecture must allow these modules to be added without major restructuring.

---

## 2. Technology Stack

### Frontend

| Technology | Purpose |
|---|---|
| Angular | Main frontend framework |
| TypeScript | Programming language |
| Angular Signals | Reactive application state |
| Angular Signal Forms | Form state and validation where appropriate |
| Angular standalone components | Component architecture |
| Angular Router | Routing and lazy loading |
| NG-ZORRO | UI component library |
| Tailwind CSS | Utility-based styling |
| SCSS | Custom styling, variables, mixins, component styles |
| MapLibre GL JS | Interactive map |
| Angular HttpClient | Backend communication |

### Backend

| Technology | Purpose |
|---|---|
| NestJS | REST API |
| TypeScript | Programming language |
| MongoDB | Main database |
| MikroORM MongoDB driver | ORM and database access |
| JWT | Authentication |
| class-validator | Request validation |
| class-transformer | DTO transformation |
| OpenAPI / Swagger | API documentation |

### Infrastructure

| Technology | Purpose |
|---|---|
| pnpm | Package manager and monorepo workspaces |
| Docker Compose | Local MongoDB |
| Cloudflare R2 or S3 | Property image storage |
| Railway | Initial hosting |
| GitHub Actions | CI/CD |
| Vitest or Jest | Unit tests, based on workspace compatibility |
| Playwright | End-to-end tests |

### Future Technologies

- BullMQ + Redis for background processing
- Photo Sphere Viewer for 360° tours
- Three.js or a compatible viewer for 3D models
- Stripe or another payment provider for subscriptions

Do not introduce these future technologies until the relevant features are being implemented.

---

## 3. Architecture

Use a **modular monolith**.

The application will consist of:

1. One Angular web application
2. One NestJS REST API
3. One MongoDB database
4. One object storage service for images and future tour assets

### Architecture Flow

    Angular Web Application
            |
            | HTTPS / REST
            v
        NestJS API
            |
            +-- Authentication
            +-- Users
            +-- Properties
            +-- Listings
            +-- Geographic Search
            +-- Media
            +-- Inquiries
            +-- Administration
            |
            +-- MongoDB
            |
            +-- Object Storage

MapLibre communicates with the configured map tile service.

Angular communicates with NestJS for all marketplace property data.

The frontend must never connect directly to MongoDB.

### Architecture Principles

- Use feature-based module organization.
- Use dependency injection.
- Keep business logic out of controllers.
- Keep database logic out of Angular components.
- Use shared API contracts where practical.
- Do not share MikroORM entities with the frontend.
- Prefer simple solutions over unnecessary abstractions.
- Avoid microservices for the MVP.
- Avoid introducing Redis unless there is a demonstrated need.
- Keep future features isolated.

---

## 4. Monorepo Folder Structure

    real-estate/
    |
    |-- apps/
    |   |
    |   |-- web/
    |   |   |-- public/
    |   |   |-- src/
    |   |   |   |-- app/
    |   |   |   |   |
    |   |   |   |   |-- core/
    |   |   |   |   |   |-- auth/
    |   |   |   |   |   |-- guards/
    |   |   |   |   |   |-- interceptors/
    |   |   |   |   |   |-- services/
    |   |   |   |   |
    |   |   |   |   |-- shared/
    |   |   |   |   |   |-- components/
    |   |   |   |   |   |-- directives/
    |   |   |   |   |   |-- pipes/
    |   |   |   |   |   |-- utils/
    |   |   |   |   |
    |   |   |   |   |-- layouts/
    |   |   |   |   |   |-- public-layout/
    |   |   |   |   |   |-- dashboard-layout/
    |   |   |   |   |
    |   |   |   |   |-- features/
    |   |   |   |   |   |-- auth/
    |   |   |   |   |   |-- property-search/
    |   |   |   |   |   |-- property-details/
    |   |   |   |   |   |-- listing-management/
    |   |   |   |   |   |-- inquiries/
    |   |   |   |   |   |-- admin/
    |   |   |   |   |
    |   |   |   |   |-- app.config.ts
    |   |   |   |   |-- app.routes.ts
    |   |   |   |   |-- app.ts
    |   |   |   |
    |   |   |   |-- styles/
    |   |   |   |   |-- _variables.scss
    |   |   |   |   |-- _mixins.scss
    |   |   |   |   |-- _overrides.scss
    |   |   |   |   |-- _typography.scss
    |   |   |   |
    |   |   |   |-- styles.scss
    |   |   |   |-- main.ts
    |   |   |
    |   |   |-- angular.json
    |   |   |-- tsconfig.json
    |   |   |-- package.json
    |   |
    |   |-- api/
    |       |-- src/
    |       |   |-- common/
    |       |   |   |-- decorators/
    |       |   |   |-- guards/
    |       |   |   |-- filters/
    |       |   |   |-- pipes/
    |       |   |
    |       |   |-- config/
    |       |   |-- database/
    |       |   |   |-- mikro-orm.config.ts
    |       |   |   |-- indexes/
    |       |   |
    |       |   |-- modules/
    |       |   |   |-- auth/
    |       |   |   |-- users/
    |       |   |   |-- properties/
    |       |   |   |-- listings/
    |       |   |   |-- search/
    |       |   |   |-- media/
    |       |   |   |-- inquiries/
    |       |   |   |-- admin/
    |       |   |
    |       |   |-- app.module.ts
    |       |   |-- main.ts
    |       |
    |       |-- test/
    |       |-- nest-cli.json
    |       |-- tsconfig.json
    |       |-- package.json
    |
    |-- packages/
    |   |-- contracts/
    |       |-- src/
    |       |   |-- auth/
    |       |   |-- properties/
    |       |   |-- listings/
    |       |   |-- search/
    |       |   |-- index.ts
    |       |-- package.json
    |
    |-- infra/
    |   |-- docker-compose.yml
    |
    |-- .env.example
    |-- .gitignore
    |-- pnpm-workspace.yaml
    |-- package.json
    |-- pnpm-lock.yaml
    |-- README.md

Create feature directories as they are needed. Do not generate every empty directory at project initialization.

---

## 5. Frontend Development Guidelines

### Angular

Follow these conventions:

- Use standalone components.
- Use Angular Signals for local and feature state.
- Use `computed()` for derived state.
- Use `inject()` instead of constructor injection where appropriate.
- Use Angular Signal Forms for supported forms and validation.
- Use `@if`, `@for`, and `@switch` instead of legacy structural directives.
- Use route-level lazy loading.
- Prefer `ChangeDetectionStrategy.OnPush`.
- Avoid unnecessary external state-management libraries.
- Keep components small and focused.
- Separate API communication from presentation.
- Use strongly typed TypeScript interfaces.
- Avoid `any` unless justified.

### SCSS Rules

**SCSS is the required stylesheet format.**

Every Angular component that needs a stylesheet should use a `.scss` file.

Example:

    property-card/
    |-- property-card.ts
    |-- property-card.html
    |-- property-card.scss

Use:

- Tailwind for common layout, spacing, and responsive utilities.
- SCSS for component-specific styling.
- NG-ZORRO for reusable interface components.
- Global SCSS partials for design tokens and consistent styling.
- SCSS modules using `@use` instead of deprecated `@import`.

Do not mix Tailwind and SCSS arbitrarily. Prefer Tailwind for simple utilities and SCSS for complex or reusable component styles.

Keep NG-ZORRO theme customization centralized. Avoid fragile overrides of internal component selectors where a supported theme API or design token is available.

Configure Angular CLI to generate SCSS by default.

### Responsive Design

Support:

- Desktop
- Tablet
- Mobile

On desktop, the property search page should display property cards and the map side by side.

On mobile, provide an easy way to switch between list and map views.

### SEO

Public property detail pages must support search-engine indexing.

Use meaningful URLs, page titles, descriptions, canonical URLs, and structured data when appropriate.

Evaluate Angular SSR for public pages. MapLibre must only initialize in the browser, never during server rendering.

Authentication, dashboards, and administration pages do not need search-engine indexing.

---

## 6. Backend Development Guidelines

Use NestJS modules organized by feature.

Example:

    properties/
    |-- dto/
    |   |-- create-property.dto.ts
    |   |-- update-property.dto.ts
    |
    |-- entities/
    |   |-- property.entity.ts
    |
    |-- properties.controller.ts
    |-- properties.service.ts
    |-- properties.module.ts

Responsibilities:

**Controller**

- Accept HTTP requests.
- Validate incoming DTOs.
- Enforce authentication and authorization guards.
- Call application services.
- Return appropriate responses.

**Service**

- Implement business logic.
- Enforce ownership and state-transition rules.
- Coordinate database operations.
- Handle domain-specific errors.

**Entity**

- Define the MongoDB persistence model using MikroORM.

Avoid unnecessary repository abstractions when MikroORM already provides the required functionality.

### Authentication

Support:

- User registration
- Login
- Logout
- Access tokens
- Refresh token rotation
- Password reset
- Email verification

Store password hashes securely.

Use HTTP-only secure cookies for refresh tokens, and keep access tokens out of persistent browser storage where practical. Configure cookie scope, SameSite policy and CSRF protections according to the deployment origin model.

### Authorization

Initial roles:

- `USER`
- `ADMIN`

A user can publish their own property listings.

An administrator can moderate published content.

Introduce organizations and agency memberships in a later phase rather than implementing complicated permissions immediately.

---

## 7. MongoDB Data Model

Use MongoDB with MikroORM.

### Collection: users

Fields:

- `_id`
- `email`
- `passwordHash`
- `firstName`
- `lastName`
- `phone`
- `role`
- `status`
- `emailVerifiedAt`
- `createdAt`
- `updatedAt`

Add a unique index on normalized email addresses.

### Collection: properties

Represents the actual physical property.

Fields:

- `_id`
- `ownerId`
- `type` — apartment, house, studio
- `details.areaM2`
- `details.bedrooms`
- `details.bathrooms`
- `details.floor`
- `details.yearBuilt`
- `details.amenities`
- `address.countryCode`
- `address.city`
- `address.neighborhood`
- `address.street`
- `privateLocation`
- `publicLocation`
- `createdAt`
- `updatedAt`

Locations must use GeoJSON.

Coordinate order is:

    [longitude, latitude]

`privateLocation` represents the precise location when supplied by an authorized publisher.

`publicLocation` represents the intentionally approximate location visible to visitors.

Public endpoints must never expose `privateLocation` or confidential street-address details.

### Collection: listings

Represents an advertisement for a property.

Fields:

- `_id`
- `propertyId`
- `publisherId`
- `transactionType` — rent or sale
- `title`
- `description`
- `price`
- `currency`
- `status`
- `publishedAt`
- `expiresAt`
- `createdAt`
- `updatedAt`

Listing status:

    draft
      |
      v
    pending_review
      |
      +--> rejected
      |
      v
    published
      |
      +--> paused
      |
      +--> archived

A listing must be approved before it becomes publicly searchable.

### Search Optimization

For MVP simplicity, duplicate the fields required by public searching directly onto listing documents.

Example searchable fields:

- `publicLocation`
- `propertyType`
- `areaM2`
- `bedrooms`
- `bathrooms`
- `city`
- `transactionType`
- `price`
- `status`

This allows a single MongoDB query to filter properties without needing to join the properties and listings collections.

The `properties` collection remains authoritative for physical property information.

Update denormalized listing fields when the canonical property information changes.

### Collection: media_assets

Fields:

- `_id`
- `listingId`
- `ownerId`
- `storageKey`
- `contentType`
- `sizeBytes`
- `width`
- `height`
- `sortOrder`
- `status`
- `createdAt`

Store image files in object storage, not MongoDB.

### Collection: inquiries

Fields:

- `_id`
- `listingId`
- `publisherId`
- `senderId` — optional
- `senderName`
- `senderEmail`
- `message`
- `status`
- `createdAt`

Support inquiries from visitors without requiring registration, with appropriate abuse prevention and email verification mechanisms where needed.

### Collection: listing_reports

Fields:

- `_id`
- `listingId`
- `reporterId` — optional
- `reason`
- `description`
- `status`
- `createdAt`

This collection supports basic content moderation.

### Indexes

Start with indexes matching actual application queries:

- `users.email` — unique
- `listings.publicLocation` — 2dsphere
- `listings.status + publishedAt`
- `listings.publisherId + createdAt`
- `listings.propertyId`
- `inquiries.publisherId + createdAt`
- `inquiries.listingId + createdAt`

Add compound filter indexes after examining query patterns and execution plans.

Maintain indexes using a repeatable provisioning script.

Do not enable unreviewed automatic production index changes.

---

## 8. Map-Based Property Search

The map is one of the main features of the marketplace.

### Requirements

- Render an interactive map using MapLibre GL JS.
- Display listings using price markers.
- Cluster overlapping markers.
- Update search results when the map moves.
- Filter by rental or sale.
- Filter by price.
- Filter by property type.
- Filter by minimum bedrooms.
- Filter by minimum property area.
- Display corresponding property cards.
- Highlight a marker when its property card is selected.
- Highlight a property card when its map marker is selected.

### Search Workflow

1. User opens the search page.
2. MapLibre initializes at the selected city.
3. Angular reads the visible map boundaries.
4. Angular sends boundaries and filters to NestJS.
5. NestJS validates the search parameters.
6. MongoDB executes a geographic query.
7. NestJS returns matching public listing data.
8. Angular updates the map markers and property results.

### Example Endpoint

    GET /api/listings/search

Query parameters:

- `west`
- `south`
- `east`
- `north`
- `transactionType`
- `minPrice`
- `maxPrice`
- `minBedrooms`
- `minAreaM2`
- `propertyType`

### Geographic Queries

Use MongoDB's `$geoWithin` operator with GeoJSON geometry.

Create a `2dsphere` index on the public coordinates used by the search.

### Performance Requirements

- Debounce requests triggered by map movement.
- Cancel outdated HTTP requests.
- Limit returned map points.
- Return only fields necessary for map markers.
- Use paginated queries for listing cards.
- Support clustering.
- Do not download the entire property database into the browser.
- Ensure indexes support the geographic query.
- Validate bounds and filter values.
- Measure query performance before adding caching.

---

## 9. Media Management

Users must be able to upload photographs for their properties.

### Requirements

- Multiple images per listing.
- Image ordering.
- Main image selection.
- Image deletion.
- Image type and size validation.
- Optimized images and thumbnails.
- Appropriate loading states.
- Lazy loading in property cards.

### Upload Workflow

1. User selects images.
2. Angular requests short-lived upload authorization from NestJS.
3. Images upload to object storage.
4. Backend validates the uploaded objects.
5. An asynchronous processing step validates actual file content, removes sensitive metadata and generates optimized versions.
6. Image metadata is stored in MongoDB.
7. Only processed, approved images become publicly visible.

Use a simple, reliable processing mechanism initially. Add a dedicated BullMQ worker when workload requires it.

Never expose object storage credentials in Angular.

---

## 10. MVP Pages

### Public Pages

**Home**

- Search bar
- Rent / Buy selection
- Featured or recent properties
- Entry point to map-based search

**Property Search**

- Interactive map
- Property list
- Filter controls
- Price markers
- Responsive mobile map/list switching

**Property Details**

- Photo gallery
- Title and price
- Property characteristics
- Description
- Approximate location
- Contact publisher form

**Authentication**

- Login
- Registration
- Password recovery

### User Dashboard

**My Listings**

- Display user's listings
- Listing statuses
- Edit or archive listings
- Create listing button

**Create / Edit Listing**

- Property information
- Address and location picker
- Listing title and description
- Price and transaction type
- Photo uploader
- Preview and submit for review

**Inquiries**

- Incoming inquiries for the user's listings

**Profile**

- Account information
- Password and contact details

### Administration

**Moderation Dashboard**

- Pending listings
- Approve or reject listings
- Remove inappropriate content
- Review reported listings
- Basic account moderation

---

## 11. API Endpoints

### Authentication

    POST   /api/auth/register
    POST   /api/auth/login
    POST   /api/auth/refresh
    POST   /api/auth/logout
    POST   /api/auth/forgot-password
    POST   /api/auth/reset-password

### Properties

    POST   /api/properties
    GET    /api/properties/:id
    PATCH  /api/properties/:id

Private property endpoints require authorization.

### Listings

    GET    /api/listings/search
    GET    /api/listings/:id
    POST   /api/listings
    PATCH  /api/listings/:id
    POST   /api/listings/:id/submit
    POST   /api/listings/:id/archive

### Current User

    GET    /api/me
    GET    /api/me/listings
    GET    /api/me/inquiries

### Media

    POST   /api/listings/:id/media/upload-url
    POST   /api/listings/:id/media/complete
    DELETE /api/listings/:id/media/:mediaId

### Inquiries

    POST   /api/listings/:id/inquiries

### Administration

    GET    /api/admin/listings/pending
    POST   /api/admin/listings/:id/approve
    POST   /api/admin/listings/:id/reject
    GET    /api/admin/reports

Apply rate limiting, authorization, and request validation as appropriate.

---

## 12. Security and Privacy

Security must be considered from the beginning.

### Authentication and Authorization

- Hash passwords using a suitable password hashing algorithm.
- Validate JWT signatures and expiry.
- Rotate refresh tokens.
- Enforce ownership checks on every property and listing mutation.
- Apply role-based authorization to administration endpoints.
- Limit login attempts.
- Support account suspension.

### API Security

- Validate and sanitize input according to context.
- Prevent MongoDB operator injection.
- Restrict CORS to approved origins.
- Apply rate limiting to public endpoints.
- Protect inquiry forms from spam.
- Restrict upload types and sizes.
- Use HTTPS in production.
- Keep secrets in environment variables.

### Property Privacy

- Do not reveal private property coordinates.
- Allow approximate public map locations.
- Do not publish sensitive address information without appropriate authorization.
- Do not expose seller contact details unnecessarily.
- Support abuse reports and listing removal.

### Data Protection

- Implement suitable privacy notices and data retention policies.
- Support account and personal-data deletion workflows.
- Protect personally identifiable information.
- Review applicable GDPR requirements before public launch.

---

## 13. Development Roadmap

The following phases should be completed sequentially.

Each phase should be independently testable.

### Phase 1 — Monorepo Foundation

**Goal:** Establish the development environment.

Tasks:

- [ ] Create Git repository.
- [ ] Configure pnpm workspaces.
- [ ] Create Angular application.
- [ ] Configure SCSS as the default stylesheet language.
- [ ] Install Tailwind CSS.
- [ ] Install and configure NG-ZORRO.
- [ ] Configure Angular Signals conventions.
- [ ] Configure Angular Signal Forms where supported.
- [ ] Create NestJS application.
- [ ] Configure MongoDB with Docker Compose.
- [ ] Configure MikroORM.
- [ ] Create shared contracts package.
- [ ] Configure environment variables.
- [ ] Configure formatting and linting.
- [ ] Configure TypeScript strict mode.
- [ ] Add health-check endpoint.
- [ ] Verify Angular can communicate with NestJS.

**Acceptance Criteria:**

- Both applications start from the monorepo root.
- Angular can successfully call the NestJS health endpoint.
- MongoDB connection is functional.
- Angular components use SCSS.
- Shared contracts compile correctly.

### Phase 2 — Authentication

**Goal:** Implement user authentication.

Tasks:

- [ ] User entity.
- [ ] Registration endpoint.
- [ ] Login endpoint.
- [ ] Password hashing.
- [ ] JWT authentication.
- [ ] Refresh-token handling.
- [ ] Login page.
- [ ] Registration page.
- [ ] Auth guard.
- [ ] Auth interceptor.
- [ ] Session state using Angular Signals.
- [ ] Logout functionality.
- [ ] Email verification and password recovery.

**Acceptance Criteria:**

Users can register, authenticate, access protected routes and securely log out.

### Phase 3 — Properties and Listings

**Goal:** Allow users to create real-estate advertisements.

Tasks:

- [ ] Property entity.
- [ ] Listing entity.
- [ ] Property CRUD endpoints.
- [ ] Listing CRUD endpoints.
- [ ] Listing status transitions.
- [ ] Create listing page.
- [ ] Listing management page.
- [ ] Property details form.
- [ ] Pricing and transaction type form.
- [ ] Location picker.
- [ ] Image upload.
- [ ] Owner authorization.
- [ ] Listing preview.

**Acceptance Criteria:**

An authenticated user can create and manage a draft listing with images and geographic information.

### Phase 4 — Public Map Search

**Goal:** Implement the core marketplace experience.

Tasks:

- [ ] Integrate MapLibre.
- [ ] Create map component.
- [ ] Create price markers.
- [ ] Implement marker clustering.
- [ ] Create MongoDB geospatial index.
- [ ] Implement geographic search endpoint.
- [ ] Implement search filters.
- [ ] Create listing cards.
- [ ] Synchronize map and list interactions.
- [ ] Add loading and empty states.
- [ ] Implement mobile map/list switching.
- [ ] Test with seeded listing data.

**Acceptance Criteria:**

Visitors can move the map and see matching published properties. Changing filters updates both the map and the list.

### Phase 5 — Public Listing Details and Inquiries

**Goal:** Complete the visitor journey.

Tasks:

- [ ] Property detail page.
- [ ] Image gallery.
- [ ] Listing characteristics.
- [ ] Approximate property location.
- [ ] Contact publisher form.
- [ ] Inquiry persistence.
- [ ] Publisher inquiry dashboard.
- [ ] Inquiry spam protection.
- [ ] SEO metadata.
- [ ] Responsive improvements.

**Acceptance Criteria:**

A visitor can find a property, inspect its details and contact the publisher.

### Phase 6 — Administration and Moderation

**Goal:** Make the marketplace ready for controlled public use.

Tasks:

- [ ] Admin access control.
- [ ] Pending listings dashboard.
- [ ] Approve listing workflow.
- [ ] Reject listing workflow.
- [ ] Listing report functionality.
- [ ] Account suspension.
- [ ] Basic moderation audit events.
- [ ] Validation and security review.

**Acceptance Criteria:**

Only approved listings appear publicly, and administrators can respond to inappropriate or fraudulent content.

### Phase 7 — Testing and Deployment

**Goal:** Release a usable public beta.

Tasks:

- [ ] Unit tests for business rules.
- [ ] Integration tests for API endpoints.
- [ ] Tests for geographic queries.
- [ ] Authorization tests.
- [ ] End-to-end critical user journeys.
- [ ] Mobile usability testing.
- [ ] Configure Railway deployment.
- [ ] Configure production MongoDB.
- [ ] Configure object storage.
- [ ] Configure CI/CD.
- [ ] Configure logging and monitoring.
- [ ] Add backup and recovery procedures.
- [ ] Verify production secrets and CORS.
- [ ] Test database restoration.
- [ ] Publish MVP.

**Acceptance Criteria:**

Users can create, discover and inquire about real listings in the production environment.

---

## 14. Future Phase — 360° Virtual Property Tours

Do not implement this during the MVP.

### Planned Features

- Upload 360° panoramic photographs.
- Create a scene for each room.
- Connect rooms through hotspots.
- Navigate between rooms.
- Embed tours on property detail pages.
- Provide full-screen viewing.
- Support mobile and desktop interaction.

### Proposed Tour Collections

**property_tours**

- `_id`
- `propertyId`
- `type`
- `title`
- `status`
- `thumbnailKey`
- `createdAt`

**tour_scenes**

- `_id`
- `tourId`
- `name`
- `panoramaStorageKey`
- `initialYaw`
- `initialPitch`
- `sortOrder`

**tour_hotspots**

- `_id`
- `tourId`
- `sourceSceneId`
- `targetSceneId`
- `yaw`
- `pitch`
- `label`

### Frontend Structure

    features/
    |-- virtual-tours/
        |-- pages/
        |   |-- tour-editor/
        |
        |-- components/
        |   |-- tour-viewer/
        |   |-- panorama-viewer/
        |   |-- hotspot-editor/
        |   |-- scene-navigator/
        |
        |-- data-access/
        |-- virtual-tours.routes.ts

Use Photo Sphere Viewer or another maintained compatible library rather than implementing panorama rendering from scratch.

---

## 15. Future Phase — True 3D Property Tours

This feature should only be considered after the marketplace has active users.

Potential capabilities:

- Interactive 3D apartment models
- Dollhouse-style property visualization
- Room selection
- Interactive floor plans
- Property model navigation
- External 3D tour integrations

The first implementation should prioritize integration with existing 3D tour technology rather than building a custom spatial reconstruction engine.

Store 3D assets in object storage.

Keep 3D viewing isolated from the core marketplace and map-search functionality.

---

## 16. Future Monetization

Do not implement payments in the MVP.

Potential monetization options:

### Individual Owners

- Free basic listings
- Paid featured listings
- Paid promotional placement

### Real-Estate Agencies

- Monthly subscriptions
- Increased listing limits
- Agency profiles
- Multiple staff accounts
- Analytics dashboards
- Listing management tools

### Virtual Tours

- Paid hosted 360° tours
- Premium storage
- Advanced tour branding

Pricing should be validated with real publishers before implementation.

---

## 17. MVP Non-Goals

Do not implement the following in the initial version:

- 3D modeling
- 360° property tours
- Online booking systems
- Payment processing
- Agency subscriptions
- Native mobile applications
- In-app real-time chat
- Complex CRM functionality
- AI property valuation
- Elasticsearch
- Microservices
- Redis or BullMQ without a clear need
- Advanced financial or geographic analytics

Focus on the basic marketplace experience first.

---

## 18. Definition of Done

The MVP is considered complete when:

1. A user can register and log in.
2. A user can create a property and a rental or sale listing.
3. A user can upload multiple property images.
4. A listing can be submitted for administrative review.
5. An administrator can approve or reject a listing.
6. Approved listings appear on the public interactive map.
7. Visitors can filter listings by relevant criteria.
8. Visitors can open complete property detail pages.
9. Visitors can contact a publisher.
10. Publishers can see incoming inquiries.
11. The application works on desktop and mobile.
12. Access control and essential security protections are in place.
13. The application is deployed and monitored.
14. Key user journeys are covered by automated tests.

---

## 19. Instructions for AI Coding Agents

When implementing this project:

- Follow the architecture in this document.
- Use Angular and NestJS.
- Use MongoDB with MikroORM, not Mongoose.
- Use pnpm workspaces.
- Use Angular standalone components.
- Prefer Signals and computed state.
- Use Angular Signal Forms where compatible.
- Use NG-ZORRO for UI components.
- Use Tailwind CSS for utility styling.
- **Always use SCSS, never plain CSS files for custom styles.**
- Use `@if` and `@for` instead of `*ngIf` and `*ngFor`.
- Prefer small, focused components and services.
- Implement one development phase at a time.
- Do not introduce features from future phases prematurely.
- Add tests for important business logic and security rules.
- Keep MongoDB queries efficient and indexed.
- Never expose private property coordinates through public APIs.
- Maintain strict separation between frontend contracts and database entities.
- Favor readable, maintainable code over premature optimization.

When an architectural decision is not specified, choose the simplest solution that satisfies the current MVP requirements while allowing reasonable future extension.

**Implementation priority:**

Foundation → Authentication → Listings → Map Search → Inquiries → Moderation → Deployment.

The marketplace must be usable before virtual-tour development begins.