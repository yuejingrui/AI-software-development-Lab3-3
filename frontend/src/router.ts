import { createRouter, createWebHistory } from "vue-router";
import HealthView from "./views/HealthView.vue";
import PlanCreateView from "./views/PlanCreateView.vue";
import PlanDetailView from "./views/PlanDetailView.vue";
import PlansListView from "./views/PlansListView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/plans" },
    { path: "/plans", name: "plans-list", component: PlansListView },
    { path: "/plans/new", name: "plans-create", component: PlanCreateView },
    { path: "/plans/:id", name: "plans-detail", component: PlanDetailView },
    { path: "/health", name: "health", component: HealthView },
  ],
});
