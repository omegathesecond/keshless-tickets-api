// api/src/services/waiterAuth.service.ts
import jwt, { SignOptions } from 'jsonwebtoken';
import { Waiter } from '@models/waiter.model';
import { WaiterToken } from '@interfaces/waiter.interface';
import { deriveWaiterPermissions } from '@interfaces/operatorGrant.interface';
import { JWT_SECRET } from '@config/jwt.config';
import { normalizeLoginCode } from '@utils/operatorCredentials.util';
import { recordFailedPinAttempt, clearPinLockout } from '@utils/pinLockout.util';

const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';

/**
 * Waiter PIN-login + token issuance. A near-copy of CashierAuthService —
 * same lockout semantics, same "generic Invalid credentials on any failure"
 * discipline — issuing a waiter-scoped JWT instead of a cashier one.
 */
export class WaiterAuthService {
  static async login(loginCode: string, pin: string) {
    if (typeof loginCode !== 'string' || typeof pin !== 'string') {
      throw new Error('Invalid credentials');
    }
    const waiter = await Waiter.findOne({
      loginCode: normalizeLoginCode(loginCode), isActive: true,
    }).select('+pin');
    if (!waiter) throw new Error('Invalid credentials');

    if (waiter.lockedUntil && waiter.lockedUntil.getTime() > Date.now()) {
      throw new Error('Account locked. Try again later.');
    }

    const ok = await waiter.comparePin(pin);
    if (!ok) {
      // Counted on the server, not on this loaded document — N guesses in
      // flight together must reach N and lock, not all write 1.
      await recordFailedPinAttempt(Waiter, waiter._id as any);
      throw new Error('Invalid credentials');
    }

    await clearPinLockout(Waiter, waiter._id as any);

    const isSuperAdmin = waiter.scope === 'platform';
    const payload: Record<string, unknown> = {
      scope: 'waiter',
      userType: 'waiter',
      waiterId: (waiter._id as any).toString(),
      role: 'waiter',
      // The POS's rendering copy only — authenticateWaiter re-derives this
      // from the row on every request, and THAT is what authorizes.
      permissions: deriveWaiterPermissions(waiter.grants),
      isSuperAdmin,
      fullName: waiter.fullName,
    };
    if (!isSuperAdmin && waiter.vendorId) payload['vendorId'] = waiter.vendorId.toString();
    if (!isSuperAdmin && waiter.eventId) payload['eventId'] = waiter.eventId.toString();

    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    // Return the actor under `operator` to match the rest of the codebase's
    // /operator/login contract (gate/reseller/merchant/cashier all do), so
    // the POS client's `data['operator']` extraction works uniformly here too.
    return {
      accessToken,
      operator: {
        id: (waiter._id as any).toString(),
        fullName: waiter.fullName,
        scope: waiter.scope,
        eventId: waiter.eventId ? waiter.eventId.toString() : null,
      },
    };
  }

  /**
   * Verify a bearer token IS a waiter-scoped JWT, returning the typed payload.
   *
   * Whitelisted field by field rather than handed on whole, mirroring
   * CashierAuthService.verifyToken: everything downstream — the event scope
   * keyed off waiterId, and the staffName stamped onto a settlement's money
   * row — reads `req.waiter` as a WaiterToken, so anything a signer put in the
   * payload beyond this shape must not travel with it.
   */
  static verifyToken(token: string): WaiterToken {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded?.scope !== 'waiter') throw new Error('Not a waiter token');
    return {
      scope: 'waiter',
      userType: 'waiter',
      waiterId: decoded.waiterId,
      role: 'waiter',
      permissions: decoded.permissions || [],
      isSuperAdmin: !!decoded.isSuperAdmin,
      fullName: decoded.fullName,
      vendorId: decoded.vendorId,
      eventId: decoded.eventId,
    };
  }
}
