<template>
    <!-- begin::sidebar user profile -->
    <div class="sidebar" id="userProfile">
        <div class="text-center p-4">
            <figure class="avatar avatar-state-success avatar-lg mb-4">
                <img :src="'/'+(user.avatar||(user.gender?'admin/assets/media/image/avatar-m.jpg' : 'admin/assets/media/image/avatar-f.jpg'))" class="rounded-circle" alt="image">
            </figure>
            <h4 class="text-primary">{{user.fname}} {{user.lname}}</h4>
            <p class="text-muted d-flex align-items-center justify-content-center line-height-0 mb-0">
                <a href="#" class="ml-2" data-toggle="tooltip" title="تنظیمات" data-sidebar-open="#settings"><i class="ti-settings"></i> </a> گروه کاربری: {{user.group.title}}
            </p>
        </div>
        <hr class="m-0">
        <div class="p-4">
            <div class="mb-4">
                <h6 class="text-uppercase font-size-11 mb-3">تنظیمات</h6>
                <div class="form-group">
                    <div class="form-item d-flex justify-content-between">
                        <label class="mt-2">حالت منو</label>
                        <div class="btn-group btn-group-sm" role="group">
                            <button type="button" @click="changeMenuType('')" :class="['p-l-r-10 btn btn-sm', menuType == '' ? 'btn-light' : 'btn-outline-light']">باز</button>
                            <button type="button" @click="changeMenuType('small-navigation')" :class="['p-l-r-10 btn btn-sm', menuType == 'small-navigation' ? 'btn-light' : 'btn-outline-light']">شناور</button>
                            <button type="button" @click="changeMenuType('hidden-navigation')" :class="['p-l-r-10 btn btn-sm', menuType == 'hidden-navigation' ? 'btn-light' : 'btn-outline-light']">مخفی</button>
                        </div>
                    </div>
                </div>
                <div class="form-group">
                    <div class="form-item custom-control custom-switch">
                        <input type="checkbox" class="custom-control-input" id="chNightMode">
                        <label class="custom-control-label" for="chNightMode">حالت شب</label>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <!-- end::sidebar user profile -->
</template>
<script>
import {mapState} from 'vuex';
export default {
    data(){
        return {
            menuType: localStorage.getItem('menu-type') || ""
        }
    },
	computed: mapState(['user']),
    methods:{
        changeMenuType(type){
            localStorage.setItem('menu-type', type);
            this.menuType = type;
            document.querySelector("body").classList.remove("hidden-navigation");
            document.querySelector("body").classList.remove("small-navigation");
            if( type ){
                document.querySelector("body").classList.add(type);
            }
        }
    },
    mounted() {
        if( localStorage.getItem('night-mode') ){
            $("#chNightMode").prop('checked', 1);
        }else{
            $("#chNightMode").prop('checked', 0);
        }
        $("#chNightMode").click(function(){
            if( $("#chNightMode").prop('checked') ){
                localStorage.setItem('night-mode', "dark");
                document.querySelector("body").classList.add('dark');
            }else{
                localStorage.setItem('night-mode', "");
                document.querySelector("body").classList.remove('dark')
            }
        });
    }
}
</script>