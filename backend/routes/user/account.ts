import { Router } from 'express';
import { serviceClient } from '../../lib/supabase.js';
import { getStripe } from '../../lib/stripe.js';

const router = Router();

// DELETE /api/user/account
router.delete('/', async (req, res) => {
  try {
    const userId = req.user!.id;

    // 0. Cancel Stripe subscription if exists
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('stripe_subscription_id')
      .eq('id', userId)
      .single();

    if (profile?.stripe_subscription_id) {
      try {
        await getStripe().subscriptions.cancel(profile.stripe_subscription_id);
      } catch (stripeErr) {
        console.error('[account DELETE] Stripe cancel error:', stripeErr);
        // Continue with deletion even if Stripe cancel fails
      }
    }

    // 1. Delete user_annotations (FK: user_id → profiles.id)
    const { error: annErr } = await serviceClient
      .from('user_annotations')
      .delete()
      .eq('user_id', userId);
    if (annErr) console.error('[account DELETE] user_annotations:', annErr.message);

    // 2. Delete annotation_feedback (FK: user_id → profiles.id)
    const { error: fbErr } = await serviceClient
      .from('annotation_feedback')
      .delete()
      .eq('user_id', userId);
    if (fbErr) console.error('[account DELETE] annotation_feedback:', fbErr.message);

    // 3. Delete user_feedback (FK: user_id → auth.users)
    const { error: ufErr } = await serviceClient
      .from('user_feedback')
      .delete()
      .eq('user_id', userId);
    if (ufErr) console.error('[account DELETE] user_feedback:', ufErr.message);

    // 4. Delete pdf_page_summaries (FK: user_id → profiles.id)
    const { error: pdfSummaryErr } = await serviceClient
      .from('pdf_page_summaries')
      .delete()
      .eq('user_id', userId);
    if (pdfSummaryErr) console.error('[account DELETE] pdf_page_summaries:', pdfSummaryErr.message);

    // 5. Delete profiles (FK: id → auth.users)
    const { error: profErr } = await serviceClient
      .from('profiles')
      .delete()
      .eq('id', userId);
    if (profErr) console.error('[account DELETE] profiles:', profErr.message);

    // 6. Delete auth user (requires service_role)
    const { error: authErr } = await serviceClient.auth.admin.deleteUser(userId);
    if (authErr) {
      res.status(500).json({ error: 'Failed to delete account' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[account DELETE] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
