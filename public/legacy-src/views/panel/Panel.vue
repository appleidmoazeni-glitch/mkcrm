<template>
    <div id="app">
        <site-userprofile></site-userprofile>
        <site-sidebar></site-sidebar>
        <site-navigation></site-navigation>
        <site-header></site-header>
        <slot></slot>
    </div>
</template>
<script>
import UserProfile from './UserProfile';
import Sidebar from './Sidebar';
import Navigation from './Navigation';
import Header from './Header';
export default {
    components: {
        'site-userprofile': UserProfile,
        'site-sidebar': Sidebar,
        'site-navigation': Navigation,
        'site-header': Header,
    }
}
</script>